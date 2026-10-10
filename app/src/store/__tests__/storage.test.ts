// One suite, two adapters. MemoryStorage and WebStorage must behave the same, so the
// same assertions run against both. SqliteStorage is not covered here because it needs
// a device or a native runtime; its logic is the same shape as these two. WebStorage is
// driven through a Map-backed localStorage stub so the browser adapter runs under jest.
import type { BondNode, Identity } from "../../model/node";
import type { Storage } from "../types";
import { MemoryStorage } from "../memory";
import { WebStorage } from "../web";
import { makeNode } from "../../model/factory";
import { generateKeypair, type RawKeypair } from "../../identity/keys";
import { signNode, verifyNode } from "../../identity/sign";

// An unsigned fixture node stands in for a legacy or agent node. Those use a non-did:key
// did (did:bond:...), which the guard allows unsigned. A did:key author with no signature
// is a forgery and is covered by its own tests below.
const author: Identity = { did: "did:bond:legacy", displayName: "A", kind: "agent" };

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

/** A real signed node with a chosen id, so verifyNode reports "verified". */
function signedNode(
  kp: RawKeypair,
  id: string,
  roomId: string,
  lamport: number,
  body = id,
): BondNode {
  const signer: Identity = { did: kp.did, displayName: "Signer", kind: "human" };
  const n = makeNode({
    roomId,
    parentId: null,
    author: signer,
    type: "text",
    payload: { body },
    lamport,
  });
  n.id = id;
  n.sig = signNode(n, kp.secretKey);
  return n;
}

/** A minimal Map-backed stand-in for the browser localStorage. */
function makeLocalStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      m.set(k, v);
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
  };
}

const cases: { name: string; setup: () => Storage }[] = [
  { name: "MemoryStorage", setup: () => new MemoryStorage() },
  {
    name: "WebStorage",
    setup: () => {
      (globalThis as { localStorage?: unknown }).localStorage = makeLocalStorage();
      return new WebStorage();
    },
  },
];

describe.each(cases)("Storage contract: $name", ({ setup }) => {
  let store: Storage;

  beforeEach(() => {
    store = setup();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("appends two nodes to a room", async () => {
    await store.append(node("a", "r1", 1));
    await store.append(node("b", "r1", 2));
    const nodes = await store.nodesForRoom("r1");
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(await store.roomIds()).toEqual(["r1"]);
  });

  it("ignores a duplicate id on appendMany", async () => {
    await store.append(node("a", "r1", 1));
    await store.appendMany([node("a", "r1", 1), node("c", "r1", 3)]);
    const nodes = await store.nodesForRoom("r1");
    expect(nodes.map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("returns nodes in lamport order", async () => {
    // Inserted out of order on purpose.
    await store.appendMany([node("b", "r1", 2), node("a", "r1", 1), node("c", "r1", 3)]);
    const nodes = await store.nodesForRoom("r1");
    expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(nodes.map((n) => n.lamport)).toEqual([1, 2, 3]);
  });

  it("reports the highest lamport per room, 0 for an unknown room", async () => {
    await store.appendMany([node("a", "r1", 1), node("b", "r1", 5), node("c", "r2", 2)]);
    expect(await store.maxLamport("r1")).toBe(5);
    expect(await store.maxLamport("r2")).toBe(2);
    expect(await store.maxLamport("nope")).toBe(0);
  });

  it("round-trips an object through setItem/getItem", async () => {
    const value = { name: "bond", nested: { count: 3, on: true }, tags: ["x", "y"] };
    await store.setItem("cfg", value);
    expect(await store.getItem("cfg")).toEqual(value);
    expect(await store.getItem("missing")).toBeNull();
  });

  it("removes a kv item", async () => {
    await store.setItem("k", { a: 1 });
    expect(await store.getItem("k")).toEqual({ a: 1 });
    await store.removeItem("k");
    expect(await store.getItem("k")).toBeNull();
  });

  it("stores a signed node and reads it back as verified", async () => {
    const kp = generateKeypair();
    await store.append(signedNode(kp, "s1", "r1", 1));
    const [back] = await store.nodesForRoom("r1");
    expect(back.id).toBe("s1");
    expect(verifyNode(back)).toBe("verified");
  });

  it("keeps an unsigned node but never presents it as verified", async () => {
    await store.append(node("u1", "r1", 1));
    const [back] = await store.nodesForRoom("r1");
    expect(back.id).toBe("u1");
    expect(verifyNode(back)).toBe("unsigned");
  });

  it("drops an unsigned node that claims a did:key author", async () => {
    // A relay injects a node with a victim did:key author and no signature. A genuine
    // did:key node is always signed, so this is impersonation and must not be stored or
    // returned as if the victim authored it.
    const victim: Identity = { did: "did:key:zVictim", displayName: "Victim", kind: "human" };
    const forged = makeNode({
      roomId: "r1",
      parentId: null,
      author: victim,
      type: "text",
      payload: { body: "I never said this" },
      lamport: 1,
    });
    forged.id = "f1";
    await store.append(forged);
    expect(await store.nodesForRoom("r1")).toEqual([]);
  });

  it("drops a tampered relayed node and never returns it", async () => {
    const kp = generateKeypair();
    const good = signedNode(kp, "ok", "r1", 1);
    const tampered = signedNode(kp, "bad", "r1", 2);
    // A relay rewrites the payload after the author signed it.
    tampered.payload = { body: "rewritten by the relay" };
    expect(verifyNode(tampered)).toBe("tampered");
    await store.append(good);
    await store.append(tampered);
    const ids = (await store.nodesForRoom("r1")).map((n) => n.id);
    expect(ids).toEqual(["ok"]);
  });

  it("drops a tampered node ingested through appendMany", async () => {
    const kp = generateKeypair();
    const good = signedNode(kp, "ok", "r1", 1);
    const tampered = signedNode(kp, "bad", "r1", 2);
    tampered.payload = { body: "rewritten" };
    await store.appendMany([good, tampered]);
    const ids = (await store.nodesForRoom("r1")).map((n) => n.id);
    expect(ids).toEqual(["ok"]);
  });

  it("rejects a forged duplicate id that would shadow a verified node", async () => {
    const real = generateKeypair();
    const attacker = generateKeypair();
    const authentic = signedNode(real, "dup", "r1", 1, "the real message");
    await store.append(authentic);
    // The attacker reuses the id with different content, signed by a different key.
    const forged = signedNode(attacker, "dup", "r1", 1, "the forged message");
    await store.append(forged);
    const nodes = await store.nodesForRoom("r1");
    expect(nodes.length).toBe(1);
    expect((nodes[0].payload as { body: string }).body).toBe("the real message");
    expect(nodes[0].sig?.signer).toBe(real.did);
  });

  it("an authentic verified node reclaims an id a shadow grabbed first", async () => {
    const real = generateKeypair();
    // An unsigned placeholder grabs the id before the authentic node arrives.
    const shadow = node("dup", "r1", 1);
    shadow.payload = { body: "shadow" };
    const authentic = signedNode(real, "dup", "r1", 1, "the real message");
    await store.append(shadow);
    await store.append(authentic);
    const nodes = await store.nodesForRoom("r1");
    expect(nodes.length).toBe(1);
    expect(nodes[0].sig?.signer).toBe(real.did);
    expect(verifyNode(nodes[0])).toBe("verified");
  });

  it("ignores a byte-identical re-send of a verified node", async () => {
    const kp = generateKeypair();
    const n = signedNode(kp, "same", "r1", 1);
    await store.append(n);
    await store.append({ ...n });
    expect((await store.nodesForRoom("r1")).length).toBe(1);
  });
});

describe("WebStorage survives a hostile localStorage", () => {
  function withRaw(seed: Record<string, string>) {
    const m = new Map<string, string>(Object.entries(seed));
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
      setItem: (k: string, v: string): void => {
        m.set(k, v);
      },
      removeItem: (k: string): void => {
        m.delete(k);
      },
    };
    return new WebStorage();
  }

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("returns [] for a malformed node array instead of throwing", async () => {
    const store = withRaw({ "bond:nodes:r1": "{ not json ]" });
    await expect(store.nodesForRoom("r1")).resolves.toEqual([]);
  });

  it("returns [] when the node value is a non-array JSON value", async () => {
    const store = withRaw({ "bond:nodes:r1": '{"id":"a"}' });
    await expect(store.nodesForRoom("r1")).resolves.toEqual([]);
  });

  it("returns null for a corrupted kv value instead of throwing", async () => {
    const store = withRaw({ "bond:kv:cfg": "<<<garbage>>>" });
    await expect(store.getItem("cfg")).resolves.toBeNull();
  });

  it("tolerates a corrupted room index and kv index", async () => {
    const store = withRaw({ "bond:rooms": "nope", "bond:kvkeys": "nope" });
    await expect(store.roomIds()).resolves.toEqual([]);
    // clear() reads both indices and must not throw on garbage.
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("caps an oversized node array so a hostile value cannot be read whole", async () => {
    const huge = Array.from({ length: 100_050 }, (_, i) => ({
      id: `n${i}`,
      roomId: "r1",
      parentId: null,
      lamport: 1,
      createdAt: new Date(0).toISOString(),
      author,
      type: "text",
      payload: { body: "x" },
    }));
    const store = withRaw({ "bond:nodes:r1": JSON.stringify(huge) });
    const back = await store.nodesForRoom("r1");
    expect(back.length).toBeLessThanOrEqual(100_000);
  });

  it("drops a node tampered at rest when it is read back", async () => {
    const kp = generateKeypair();
    const good = signedNode(kp, "ok", "r1", 1);
    const tampered = signedNode(kp, "bad", "r1", 2);
    // Rewrite the stored bytes after signing, the way a hostile localStorage edit would.
    tampered.payload = { body: "edited at rest" };
    const store = withRaw({ "bond:nodes:r1": JSON.stringify([good, tampered]) });
    const ids = (await store.nodesForRoom("r1")).map((n) => n.id);
    expect(ids).toEqual(["ok"]);
  });

  it("drops an unsigned did:key node injected directly at rest", async () => {
    // A hostile localStorage edit adds a node with a victim did:key author and no signature.
    // Reading it back must not present it as the victim's message.
    const forged = {
      id: "f1",
      roomId: "r1",
      parentId: null,
      lamport: 1,
      createdAt: new Date(0).toISOString(),
      author: { did: "did:key:zVictim", displayName: "Victim", kind: "human" },
      type: "text",
      payload: { body: "forged at rest" },
    };
    const store = withRaw({ "bond:nodes:r1": JSON.stringify([forged]) });
    expect(await store.nodesForRoom("r1")).toEqual([]);
  });
});
