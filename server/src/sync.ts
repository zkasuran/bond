import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";

// A synced node. It carries at least an id and a lamport clock. Everything
// else is opaque payload the client owns.
export interface SyncNode {
  id: string;
  lamport: number;
  [key: string]: unknown;
}

// Room state. nodes is the store keyed by node id, members are the live
// sockets subscribed to that room.
const store = new Map<string, Map<string, SyncNode>>();
const members = new Map<string, Set<WebSocket>>();

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
  socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
  socket.destroy();
}

// Mount the sync WebSocket server on an existing HTTP server. Auth and the
// room parameter are checked during the upgrade so a bad client never gets
// an open socket.
export function mountSync(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on(
    "upgrade",
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "", "http://localhost");
      } catch {
        reject(socket, 400, "Bad Request");
        return;
      }
      if (url.pathname !== "/sync") {
        // Not ours. Leave it for any other upgrade handler, then close.
        reject(socket, 404, "Not Found");
        return;
      }

      // Accept the token from the Authorization header or, for browsers that
      // cannot set it on a WebSocket, from ?token=.
      const token =
        bearerFrom(req.headers.authorization) ?? url.searchParams.get("token");
      if (!config.bondBearer || token !== config.bondBearer) {
        reject(socket, 401, "Unauthorized");
        return;
      }

      const room = url.searchParams.get("room");
      if (!room) {
        reject(socket, 400, "Bad Request");
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

      ws.on("message", (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
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
            ws.send(JSON.stringify({ type: "node", node }));
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
          nodes.set(node.id, node);

          const payload = JSON.stringify({ type: "node", node });
          for (const client of roomMembers(room)) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(payload);
            }
          }
        }
      });

      ws.on("close", () => {
        const set = members.get(room);
        if (!set) return;
        set.delete(ws);
        if (set.size === 0) members.delete(room);
      });
    },
  );

  return wss;
}
