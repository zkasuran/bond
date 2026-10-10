import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { config } from "./config.js";
import { mountSync, admitSocket, withinStoreBudget, replaySince, type SyncNode } from "./sync.js";
import {
  MAX_NODE_BYTES,
  MAX_SOCKET_BUFFER_BYTES,
  MAX_SOCKETS_PER_ROOM,
  MAX_TOTAL_SOCKETS,
  MAX_TOTAL_STORE_BYTES,
} from "./limits.js";

// Pin a deterministic token so the test does not depend on a local .env. Each
// test file runs in its own process, so this never leaks to other suites.
const TOKEN = "sync-test-token";
config.bondBearer = TOKEN;

function startServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    mountSync(server);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function url(port: number, room?: string, token: string | null = TOKEN): string {
  const u = new URL(`ws://127.0.0.1:${port}/sync`);
  if (token) u.searchParams.set("token", token);
  if (room) u.searchParams.set("room", room);
  return u.toString();
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A same-origin header derived from the ws target. Sync now fails closed on a
// missing Origin, so every ordinary test client presents a same-origin header
// (the server treats a matching Origin host as same-origin). Pass origin = null
// to send none. Pass a string to send a specific one.
function sameOrigin(target: string): string {
  return `http://${new URL(target).host}`;
}

function wsOptions(target: string, origin: string | null | undefined): { origin?: string } {
  if (origin === null) return {};
  return { origin: origin ?? sameOrigin(target) };
}

// Open a socket and resolve once it is live. A no-op error listener keeps a
// later server-side close from surfacing as an unhandled error in the test.
function open(target: string, origin?: string | null): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target, wsOptions(target, origin));
    ws.on("error", () => {});
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`rejected ${res.statusCode}`)),
    );
  });
}

// Resolve with the HTTP status an upgrade was rejected with.
function expectRejected(target: string, origin?: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target, wsOptions(target, origin));
    ws.on("error", () => {});
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("expected rejection, socket opened"));
    });
  });
}

// APPEND-TESTS-HERE

test("upgrade with a bad token is rejected with 401", async () => {
  const { server, port } = await startServer();
  try {
    const status = await expectRejected(url(port, "room-a", "wrong-token"));
    assert.equal(status, 401);
  } finally {
    await stopServer(server);
  }
});

test("upgrade with a missing room is rejected with 400", async () => {
  const { server, port } = await startServer();
  try {
    const status = await expectRejected(url(port, undefined, TOKEN));
    assert.equal(status, 400);
  } finally {
    await stopServer(server);
  }
});

test("a duplicate-id node is stored and broadcast only once", async () => {
  const { server, port } = await startServer();
  const a = await open(url(port, "dup"));
  const b = await open(url(port, "dup"));
  const seen: string[] = [];
  b.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "node") seen.push(m.node.id);
  });
  try {
    const node = JSON.stringify({ type: "node", node: { id: "n1", lamport: 1, text: "hi" } });
    a.send(node);
    await delay(120);
    a.send(node); // same id again
    await delay(120);
    assert.deepEqual(seen, ["n1"], "the second send of the same id must not rebroadcast");
  } finally {
    a.close();
    b.close();
    await stopServer(server);
  }
});

test("a malformed frame and an oversized frame do not crash the server", async () => {
  const { server, port } = await startServer();
  const a = await open(url(port, "harden"));
  const b = await open(url(port, "harden"));
  const seen: string[] = [];
  b.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "node") seen.push(m.node.id);
  });
  try {
    a.send("this is not json at all");
    a.send(Buffer.alloc(MAX_NODE_BYTES + 4096, 0x41)); // over maxPayload
    await delay(150);

    // The server survived: a fresh client can still join the room and sync.
    const c = await open(url(port, "harden"));
    c.send(JSON.stringify({ type: "node", node: { id: "alive", lamport: 2 } }));
    await delay(150);
    assert.ok(seen.includes("alive"), "the server kept serving after hostile frames");
    c.close();
  } finally {
    a.close();
    b.close();
    await stopServer(server);
  }
});

// --- F20 HIGH: outbound backpressure ---------------------------------------

// A minimal socket stand-in. replaySince only reads readyState and bufferedAmount
// and calls send/terminate, so this drives the backpressure path without having
// to overflow a real TCP buffer against the per-socket rate limits.
function fakeSocket(bufferedAmount: number): {
  readyState: number;
  bufferedAmount: number;
  sent: number;
  terminated: boolean;
  send(): void;
  terminate(): void;
} {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount,
    sent: 0,
    terminated: false,
    send() {
      this.sent += 1;
    },
    terminate() {
      this.terminated = true;
      this.readyState = WebSocket.CLOSED;
    },
  };
}

const manyNodes: SyncNode[] = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, lamport: i + 1 }));

test("replaySince drops a reader that never drains instead of buffering the whole room", async () => {
  const sock = fakeSocket(MAX_SOCKET_BUFFER_BYTES + 1); // stays over the ceiling
  await replaySince(sock as unknown as WebSocket, manyNodes);
  assert.ok(sock.terminated, "a non-draining reader is terminated");
  assert.ok(sock.sent < manyNodes.length, "the server did not buffer the whole replay");
});

test("replaySince sends the full replay to a reader that drains", async () => {
  const sock = fakeSocket(0); // always drained
  await replaySince(sock as unknown as WebSocket, manyNodes);
  assert.equal(sock.sent, manyNodes.length);
  assert.ok(!sock.terminated);
});

// --- F20 MED: socket and store ceilings ------------------------------------

test("admitSocket caps sockets per room and across all rooms", () => {
  assert.equal(admitSocket(0, 0), true);
  assert.equal(admitSocket(MAX_TOTAL_SOCKETS, 0), false);
  assert.equal(admitSocket(0, MAX_SOCKETS_PER_ROOM), false);
  assert.equal(admitSocket(MAX_TOTAL_SOCKETS - 1, MAX_SOCKETS_PER_ROOM - 1), true);
});

test("withinStoreBudget enforces one global store ceiling across rooms", () => {
  assert.equal(withinStoreBudget(0, 1), true);
  assert.equal(withinStoreBudget(MAX_TOTAL_STORE_BYTES, 1), false);
  assert.equal(withinStoreBudget(MAX_TOTAL_STORE_BYTES - 10, 10), true);
  assert.equal(withinStoreBudget(MAX_TOTAL_STORE_BYTES - 10, 11), false);
});

// --- F20 MED: dedupe must not let a forgery pin an id ----------------------

test("a different node under an existing id is rebroadcast, not shadowed by the first", async () => {
  const { server, port } = await startServer();
  const attacker = await open(url(port, "pin"));
  const author = await open(url(port, "pin"));
  const watcher = await open(url(port, "pin"));
  const seen: Array<{ id: string; text: unknown }> = [];
  watcher.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "node") seen.push({ id: m.node.id, text: m.node.text });
  });
  try {
    attacker.send(JSON.stringify({ type: "node", node: { id: "x", lamport: 1, text: "forged" } }));
    await delay(120);
    author.send(JSON.stringify({ type: "node", node: { id: "x", lamport: 1, text: "authentic" } }));
    await delay(150);
    const texts = seen.filter((s) => s.id === "x").map((s) => s.text);
    assert.ok(texts.includes("forged"), "the first node reached the room");
    assert.ok(
      texts.includes("authentic"),
      "the differing same-id node was rebroadcast so clients can re-verify it",
    );
  } finally {
    attacker.close();
    author.close();
    watcher.close();
    await stopServer(server);
  }
});

// --- F20: origin fails closed ----------------------------------------------

test("a sync upgrade with no Origin header is rejected (fail closed)", async () => {
  const { server, port } = await startServer();
  try {
    const status = await expectRejected(url(port, "o-none"), null);
    assert.equal(status, 403);
  } finally {
    await stopServer(server);
  }
});

test("a sync upgrade from a disallowed Origin is rejected", async () => {
  const { server, port } = await startServer();
  try {
    const status = await expectRejected(url(port, "o-bad"), "http://evil.example.com");
    assert.equal(status, 403);
  } finally {
    await stopServer(server);
  }
});

test("a sync upgrade from an allowlisted Origin is accepted", async () => {
  const { server, port } = await startServer();
  const prev = config.allowedOrigins;
  config.allowedOrigins = ["http://good.example.com"];
  try {
    const ws = await open(url(port, "o-good"), "http://good.example.com");
    ws.close();
  } finally {
    config.allowedOrigins = prev;
    await stopServer(server);
  }
});

test("a no-Origin client is accepted only when SYNC_ALLOW_MISSING_ORIGIN is set", async () => {
  const { server, port } = await startServer();
  config.syncAllowMissingOrigin = true;
  try {
    const ws = await open(url(port, "o-native"), null);
    ws.close();
  } finally {
    config.syncAllowMissingOrigin = false;
    await stopServer(server);
  }
});

