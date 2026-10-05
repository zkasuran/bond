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

// A same-origin request and a non-browser client that sends no Origin header
// are always allowed. A browser cross-origin request is allowed only when its
// Origin is in the configured allowlist. This blocks cross-site WebSocket
// hijacking without breaking the bundled web build or the native app.
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
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
      if (!members.has(room) && members.size >= MAX_ROOMS) {
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
          const nodes = [...roomStore(room).values()]
            .filter((n) => n.lamport > since)
            .sort((a, b) => a.lamport - b.lamport);
          for (const node of nodes) {
            try {
              ws.send(JSON.stringify({ type: "node", node }));
            } catch {
              // The socket may have closed mid-replay. Stop feeding it.
              break;
            }
          }
          return;
        }

        if (m.type === "node") {
          const node = m.node as SyncNode | undefined;
          if (!node || typeof node.id !== "string") return;
          if (typeof node.lamport !== "number") node.lamport = 0;

          const nodes = roomStore(room);
          // Dedupe by id. A node we already hold is not stored again and not
          // rebroadcast, so reconnect replays never echo round the room.
          if (nodes.has(node.id)) return;

          // Bound the store. Past the ceiling the oldest node is evicted so the
          // room keeps syncing without the store growing without end.
          if (nodes.size >= MAX_NODES_PER_ROOM) {
            const oldest = nodes.keys().next().value;
            if (oldest !== undefined) nodes.delete(oldest);
          }
          nodes.set(node.id, node);

          const payload = JSON.stringify({ type: "node", node });
          for (const client of roomMembers(room)) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              try {
                client.send(payload);
              } catch {
                // A failed send to one peer must not stop the broadcast to the
                // rest of the room.
              }
            }
          }
        }
      });

      ws.on("close", () => {
        const set = members.get(room);
        if (!set) return;
        set.delete(ws);
        if (set.size === 0) {
          members.delete(room);
          // Free the room's stored nodes once nobody is left to replay them to.
          store.delete(room);
        }
      });
    },
  );

  return wss;
}
