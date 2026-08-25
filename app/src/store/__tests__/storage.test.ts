// One suite, two adapters. MemoryStorage and WebStorage must behave the same, so the
// same assertions run against both. SqliteStorage is not covered here because it needs
// a device or a native runtime; its logic is the same shape as these two. WebStorage is
// driven through a Map-backed localStorage stub so the browser adapter runs under jest.
import type { BondNode, Identity } from "../../model/node";
import type { Storage } from "../types";
import { MemoryStorage } from "../memory";
import { WebStorage } from "../web";

const author: Identity = { did: "did:key:zA", displayName: "A", kind: "human" };

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
});
