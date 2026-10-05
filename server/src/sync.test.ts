import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { config } from "./config.js";
import { mountSync } from "./sync.js";
import { MAX_NODE_BYTES } from "./limits.js";

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

// Open a socket and resolve once it is live. A no-op error listener keeps a
// later server-side close from surfacing as an unhandled error in the test.
function open(target: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    ws.on("error", () => {});
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`rejected ${res.statusCode}`)),
    );
  });
}

// Resolve with the HTTP status an upgrade was rejected with.
function expectRejected(target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
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

