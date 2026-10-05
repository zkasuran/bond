// The /sync client treats the server as an untrusted relay. These tests drive it with a
// mocked global WebSocket then assert the honest claim end to end: a relayed node is ingested
// through the Storage port where the verify gate runs, so a valid node reads back verified, a
// tampered node is dropped, a duplicate does not double-apply, an oversized or malformed frame
// never reaches the store, then the reconnect backoff is bounded and does not spin.
import type { BondNode, Identity } from "../../model/node";
import { makeNode } from "../../model/factory";
import { generateKeypair, type RawKeypair } from "../../identity/keys";
import { signNode, verifyNode } from "../../identity/sign";
import { MemoryStorage } from "../../store/memory";
import {
  SyncClient,
  computeBackoff,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_INBOUND_BYTES,
} from "../client";

const ROOM = "r-sync";

// A test double for the browser / React Native WebSocket, installed as the global so the
// client's default socket factory picks it up. Every socket it builds is recorded so a test
// can open it, feed it a frame then drop it.
class FakeSocket {
  static instances: FakeSocket[] = [];
  static last(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }
  readyState = 0;
  url: string;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  simOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  simMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}
const author: Identity = { did: "did:key:zA", displayName: "A", kind: "human" };

/** An unsigned node with a chosen id, the honest neutral default for a relayed node. */
function node(id: string, roomId: string, lamport: number): BondNode {
  return {
    id,
    roomId,
    parentId: null,
    lamport,
    createdAt: new Date(0).toISOString(),
    author,
    type: "text",
    payload: { body: id },
  };
}

/** A real signed node so verifyNode reports "verified" after a round trip through the store. */
function signedNode(
  kp: RawKeypair,
  id: string,
  roomId: string,
  lamport: number,
  body = id,
): BondNode {
  const signer: Identity = { did: kp.did, displayName: "Signer", kind: "human" };
  const n = makeNode({ roomId, parentId: null, author: signer, type: "text", payload: { body }, lamport });
  n.id = id;
  n.sig = signNode(n, kp.secretKey);
  return n;
}

const frame = (n: unknown): string => JSON.stringify({ type: "node", node: n });

// Let the fire-and-forget ingest (onRemoteNode -> storage.append -> re-read) settle.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
});

afterEach(() => {
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

function makeClient(storage: MemoryStorage, onRemoteNode?: (n: BondNode) => void | Promise<void>) {
  return new SyncClient({
    gatewayBaseUrl: "http://localhost:8080/v1",
    token: "device-token",
    roomId: ROOM,
    sinceLamport: () => 0,
    onRemoteNode: onRemoteNode ?? ((n) => storage.append(n)),
    random: () => 0,
  });
}
describe("sync client ingests relayed nodes through the store gate", () => {
  it("appends a valid remote node and reads it back verified", async () => {
    const kp = generateKeypair();
    const storage = new MemoryStorage();
    const client = makeClient(storage);
    client.start();
    const sock = FakeSocket.last();
    sock.simOpen();
    sock.simMessage(frame(signedNode(kp, "ok", ROOM, 1)));
    await flush();

    const back = await storage.nodesForRoom(ROOM);
    expect(back.map((n) => n.id)).toEqual(["ok"]);
    expect(verifyNode(back[0])).toBe("verified");
    // On open the client runs the handshake, so the server replays only what is missing.
    expect(JSON.parse(sock.sent[0])).toMatchObject({ type: "hello", lastLamport: 0 });
    client.stop();
  });

  it("drops a tampered remote node and never stores it", async () => {
    const kp = generateKeypair();
    const storage = new MemoryStorage();
    const client = makeClient(storage);
    client.start();
    const sock = FakeSocket.last();
    sock.simOpen();

    const tampered = signedNode(kp, "bad", ROOM, 2);
    // A relay rewrites the payload after the author signed it.
    tampered.payload = { body: "rewritten by the relay" };
    sock.simMessage(frame(signedNode(kp, "ok", ROOM, 1)));
    sock.simMessage(frame(tampered));
    await flush();

    expect((await storage.nodesForRoom(ROOM)).map((n) => n.id)).toEqual(["ok"]);
    client.stop();
  });

  it("does not double-apply a duplicate id", async () => {
    const kp = generateKeypair();
    const storage = new MemoryStorage();
    const client = makeClient(storage);
    client.start();
    const sock = FakeSocket.last();
    sock.simOpen();

    const dup = signedNode(kp, "dup", ROOM, 1);
    sock.simMessage(frame(dup));
    sock.simMessage(frame(dup)); // the reconnect replay would resend the same id
    await flush();

    expect((await storage.nodesForRoom(ROOM)).length).toBe(1);
    client.stop();
  });
  it("rejects an oversized frame before it reaches the store", async () => {
    const storage = new MemoryStorage();
    const onRemoteNode = jest.fn((n: BondNode) => storage.append(n));
    const client = makeClient(storage, onRemoteNode);
    client.start();
    const sock = FakeSocket.last();
    sock.simOpen();

    // One frame over the inbound cap, plus a well-formed node wrapped in that oversized frame
    // so the only reason to drop it is the size.
    const big = node("big", ROOM, 1);
    let huge = frame(big);
    huge = huge + "x".repeat(MAX_INBOUND_BYTES + 1 - huge.length);
    sock.simMessage(huge);
    await flush();

    expect(onRemoteNode).not.toHaveBeenCalled();
    expect((await storage.nodesForRoom(ROOM)).length).toBe(0);
    client.stop();
  });

  it("rejects a malformed node (no author) at the wire boundary", async () => {
    const storage = new MemoryStorage();
    const onRemoteNode = jest.fn((n: BondNode) => storage.append(n));
    const client = makeClient(storage, onRemoteNode);
    client.start();
    const sock = FakeSocket.last();
    sock.simOpen();

    // Missing author.did would crash the ordered read path, so the shape guard must refuse it.
    sock.simMessage(frame({ id: "x", roomId: ROOM, lamport: 1, parentId: null, type: "text", payload: { body: "hi" } }));
    sock.simMessage("this is not json at all");
    await flush();

    expect(onRemoteNode).not.toHaveBeenCalled();
    expect((await storage.nodesForRoom(ROOM)).length).toBe(0);
    client.stop();
  });
});
describe("sync client reconnect backoff is bounded", () => {
  it("computeBackoff grows then plateaus at the cap, never zero", () => {
    expect(computeBackoff(0)).toBe(BASE_BACKOFF_MS);
    expect(computeBackoff(0)).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      expect(computeBackoff(i + 1)).toBeGreaterThanOrEqual(computeBackoff(i));
      expect(computeBackoff(i)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
    expect(computeBackoff(1000)).toBe(MAX_BACKOFF_MS);
  });

  it("schedules each retry with a capped delay and never spins", () => {
    jest.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const client = makeClient(storage); // random: () => 0, so the delay is exactly computeBackoff
      client.start();
      expect(FakeSocket.instances.length).toBe(1);

      let created = 1;
      for (let attempt = 0; attempt < 8; attempt++) {
        FakeSocket.instances[created - 1].onclose?.({});
        // A spinning client would reconnect synchronously. This one only schedules a timer.
        expect(FakeSocket.instances.length).toBe(created);

        const expected = computeBackoff(attempt);
        jest.advanceTimersByTime(expected - 1);
        expect(FakeSocket.instances.length).toBe(created); // one tick short: no retry yet
        jest.advanceTimersByTime(1);
        created += 1;
        expect(FakeSocket.instances.length).toBe(created); // crossing the delay: exactly one retry
      }
      // The last delays ran at the ceiling, so the backoff never grew without end.
      expect(computeBackoff(7)).toBe(MAX_BACKOFF_MS);
      client.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

