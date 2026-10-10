import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { config, bearerMatches } from "./config.js";
import {
  MAX_NODE_BYTES,
  MAX_ROOMS,
  MAX_NODES_PER_ROOM,
  SYNC_MSG_BURST,
  SYNC_MSG_PER_SEC,
  SYNC_BYTES_BURST,
  SYNC_BYTES_PER_SEC,
  SYNC_UPGRADE_BURST,
  SYNC_UPGRADE_PER_SEC,
  MAX_RATE_LIMIT_KEYS,
  MAX_SOCKET_BUFFER_BYTES,
  SOCKET_DRAIN_TIMEOUT_MS,
  SOCKET_DRAIN_POLL_MS,
  MAX_SOCKETS_PER_ROOM,
  MAX_TOTAL_SOCKETS,
  MAX_TOTAL_STORE_BYTES,
  TokenBucket,
  KeyedRateLimiter,
} from "./limits.js";

// A synced node. It carries at least an id and a lamport clock. Everything
// else is opaque payload the client owns.
export interface SyncNode {
  id: string;
  lamport: number;
  [key: string]: unknown;
}

// Room state. nodes is the store keyed by node id, members are the live
// sockets subscribed to that room. A room exists in members only while it has a
// live socket. Its store entry is freed when the last member leaves, so an idle
// room holds no memory.
const store = new Map<string, Map<string, SyncNode>>();
const members = new Map<string, Set<WebSocket>>();

// Total bytes retained across every room's store, plus the count of live
// sockets. Both are tracked so a global ceiling can be enforced that the
// per-room limits alone cannot (the per-room and per-node ceilings would
// otherwise multiply into an unbounded total).
let totalStoreBytes = 0;
let liveSockets = 0;

// Per-IP cap on how fast one address can open sync sockets.
const upgradeLimiter = new KeyedRateLimiter(
  SYNC_UPGRADE_BURST,
  SYNC_UPGRADE_PER_SEC,
  MAX_RATE_LIMIT_KEYS,
);

function roomStore(room: string): Map<string, SyncNode> {
  let m = store.get(room);
  if (!m) {
    m = new Map<string, SyncNode>();
    store.set(room, m);
  }
  return m;
}

function roomMembers(room: string): Set<WebSocket> {
  let s = members.get(room);
  if (!s) {
    s = new Set<WebSocket>();
    members.set(room, s);
  }
  return s;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// A new socket is admitted only while both the global and the per-room socket
// ceilings have room. Pure so the ceiling logic is tested without opening
// thousands of real sockets (which the per-IP upgrade limiter would throttle).
export function admitSocket(totalLive: number, roomLive: number): boolean {
  return totalLive < MAX_TOTAL_SOCKETS && roomLive < MAX_SOCKETS_PER_ROOM;
}

// A node is retained only while the global store budget has room for it. Pure for
// the same reason as admitSocket.
export function withinStoreBudget(currentBytes: number, incomingBytes: number): boolean {
  return currentBytes + incomingBytes <= MAX_TOTAL_STORE_BYTES;
}

// Store a brand-new node under the per-room node ceiling and the global byte
// budget. Past the per-room ceiling the oldest node is evicted. Past the global
// budget the node is not retained (the caller still relays it live), so total
// memory stays bounded across all rooms.
function storeNode(nodes: Map<string, SyncNode>, node: SyncNode, nodeJson: string): void {
  while (nodes.size >= MAX_NODES_PER_ROOM) {
    const oldestId = nodes.keys().next().value as string | undefined;
    if (oldestId === undefined) break;
    const old = nodes.get(oldestId);
    nodes.delete(oldestId);
    if (old) totalStoreBytes -= byteLen(JSON.stringify(old));
  }
  const size = byteLen(nodeJson);
  if (!withinStoreBudget(totalStoreBytes, size)) return;
  nodes.set(node.id, node);
  totalStoreBytes += size;
}

// Resolve true once the socket's outbound buffer has drained below the ceiling,
// or false if it never does inside the window (or the socket closed). Polling,
// because the ws drain event does not fire while a reader simply stops reading.
function drained(ws: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + SOCKET_DRAIN_TIMEOUT_MS;
    const poll = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return resolve(false);
      if (ws.bufferedAmount <= MAX_SOCKET_BUFFER_BYTES) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, SOCKET_DRAIN_POLL_MS);
    };
    poll();
  });
}

// Replay stored nodes to one socket with backpressure. Outbound buffering is
// capped: when the socket's unflushed buffer passes the ceiling the replay pauses
// and waits for it to drain. A reader that never drains is dropped. One tiny
// hello frame can therefore never force the server to buffer a whole room, which
// is the memory-exhaustion path the per-message rate limit does not cover.
export async function replaySince(ws: WebSocket, nodes: readonly SyncNode[]): Promise<void> {
  for (const node of nodes) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES && !(await drained(ws))) {
      try {
        ws.terminate();
      } catch {
        // Socket already gone. Nothing to free.
      }
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "node", node }));
    } catch {
      // The socket closed mid-replay. Stop feeding it.
      return;
    }
  }
}

// Fan a node out to every other live member of a room, with the same outbound cap
// as the replay. A member whose buffer is already past the ceiling is dropped
// rather than fed, so a single slow reader in a busy room cannot grow memory.
function broadcastNode(room: string, from: WebSocket, payload: string): void {
  for (const client of roomMembers(room)) {
    if (client === from || client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
      try {
        client.terminate();
      } catch {
        // Already gone.
      }
      continue;
    }
    try {
      client.send(payload);
    } catch {
      // A failed send to one peer must not stop the broadcast to the rest.
    }
  }
}

function bearerFrom(header?: string): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function reject(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
    socket.destroy();
  } catch {
    // The peer may have already gone. Nothing to clean up beyond this point.
  }
}

// A same-origin request is always allowed. A cross-origin browser request is
// allowed only when its Origin is in the configured allowlist. A request that
// carries no Origin is rejected by default (fail closed): a browser always sends
// Origin, so this only turns away non-browser clients. A native deployment that
// needs them sets SYNC_ALLOW_MISSING_ORIGIN=1. This blocks cross-site WebSocket
// hijacking without a silent allow-all bypass for any client that simply omits
// the header.
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return config.syncAllowMissingOrigin;
  try {
    const o = new URL(origin);
    const host = req.headers.host;
    if (host && o.host === host) return true;
  } catch {
    return false;
  }
  return config.allowedOrigins.includes(origin);
}

// Mount the sync WebSocket server on an existing HTTP server. Auth, the origin,
// a rate limit and the room parameter are all checked during the upgrade so a
// bad client never gets an open socket.
export function mountSync(server: Server): WebSocketServer {
  // maxPayload closes an oversized frame at the library boundary rather than
  // buffering it, so one hostile frame cannot exhaust memory.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NODE_BYTES });

  // A server-level error must never take the process down.
  wss.on("error", (err) => {
    console.error("sync wss error:", err instanceof Error ? err.message : err);
  });

  server.on(
    "upgrade",
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // A socket-level error during the upgrade must not crash the process.
      socket.on("error", () => {});

      let url: URL;
      try {
        url = new URL(req.url ?? "", "http://localhost");
      } catch {
        reject(socket, 400, "Bad Request");
        return;
      }
      if (url.pathname !== "/sync") {
        reject(socket, 404, "Not Found");
        return;
      }

      if (!originAllowed(req)) {
        reject(socket, 403, "Forbidden");
        return;
      }

      const ip = req.socket.remoteAddress ?? "unknown";
      if (!upgradeLimiter.allow(ip)) {
        reject(socket, 429, "Too Many Requests");
        return;
      }

      // Accept the token from the Authorization header or, for browsers that
      // cannot set it on a WebSocket, from ?token=. Compared in constant time.
      const token =
        bearerFrom(req.headers.authorization) ?? url.searchParams.get("token");
      if (!bearerMatches(token, config.bondBearer)) {
        reject(socket, 401, "Unauthorized");
        return;
      }

      const room = url.searchParams.get("room");
      if (!room) {
        reject(socket, 400, "Bad Request");
        return;
      }

      // Refuse a brand-new room once the room ceiling is reached. A reconnect to
      // a room that already has members is always allowed.
      const roomSet = members.get(room);
      if (!roomSet && members.size >= MAX_ROOMS) {
        reject(socket, 503, "Service Unavailable");
        return;
      }

      // Cap live sockets per room and across all rooms. Unlike the room ceiling
      // this fires for reconnects to an existing room too, so one known room id
      // cannot be used to open unbounded sockets and exhaust file descriptors.
      if (!admitSocket(liveSockets, roomSet?.size ?? 0)) {
        reject(socket, 503, "Service Unavailable");
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, room);
      });
    },
  );

  wss.on(
    "connection",
    (ws: WebSocket, _req: IncomingMessage, room: string) => {
      liveSockets += 1;
      roomMembers(room).add(ws);

      // Per-socket token buckets. A socket over either budget has the offending
      // frame dropped rather than being allowed to flood the room.
      const msgBucket = new TokenBucket(SYNC_MSG_BURST, SYNC_MSG_PER_SEC);
      const byteBucket = new TokenBucket(SYNC_BYTES_BURST, SYNC_BYTES_PER_SEC);

      // A per-socket error (reset peer, oversized frame, protocol fault) is
      // logged and never rethrown, so one bad socket cannot crash the server.
      ws.on("error", (err) => {
        console.error("sync socket error:", err instanceof Error ? err.message : err);
      });

      ws.on("message", (data) => {
        const raw = data.toString();
        if (!msgBucket.take(1) || !byteBucket.take(raw.length)) return;

        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (typeof msg !== "object" || msg == null) return;
        const m = msg as Record<string, unknown>;

        if (m.type === "hello") {
          const since = Number(m.lastLamport ?? 0);
          const toReplay = [...roomStore(room).values()]
            .filter((n) => n.lamport > since)
            .sort((a, b) => a.lamport - b.lamport);
          // Backpressure-aware replay. One tiny hello cannot force the server to
          // buffer the whole room: replaySince caps outbound buffering and drops
          // a reader that never drains.
          void replaySince(ws, toReplay);
          return;
        }

        if (m.type === "node") {
          const node = m.node as SyncNode | undefined;
          if (!node || typeof node.id !== "string") return;
          if (typeof node.lamport !== "number") node.lamport = 0;

          const nodes = roomStore(room);
          const nodeJson = JSON.stringify(node);
          const payload = JSON.stringify({ type: "node", node });
          const existing = nodes.get(node.id);

          if (existing) {
            // An identical duplicate is a reconnect echo: do not store or
            // rebroadcast it again. A different node under the same id must not
            // be shadowed by whichever arrived first. The relay cannot verify a
            // signature and must not vouch for authorship, so it rebroadcasts the
            // differing node for every live client to re-verify, keeping the
            // authentic one reachable. It does not overwrite the stored copy or
            // grow the store, so a forgery can neither pin an id nor evict history.
            if (JSON.stringify(existing) === nodeJson) return;
            broadcastNode(room, ws, payload);
            return;
          }

          // Brand-new id. Retain it under the per-room ceiling and the global
          // byte budget, then relay it to the room.
          storeNode(nodes, node, nodeJson);
          broadcastNode(room, ws, payload);
        }
      });

      ws.on("close", () => {
        liveSockets -= 1;
        const set = members.get(room);
        if (!set) return;
        set.delete(ws);
        if (set.size === 0) {
          members.delete(room);
          // Free the room's stored nodes once nobody is left to replay them to,
          // and release their bytes from the global store budget.
          const m = store.get(room);
          if (m) {
            for (const n of m.values()) totalStoreBytes -= byteLen(JSON.stringify(n));
            store.delete(room);
          }
        }
      });
    },
  );

  return wss;
}
