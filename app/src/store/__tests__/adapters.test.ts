// Adversarial store-adapter tests for F05. The shared Storage contract lives in
// storage.test.ts. This file adds the hostile-input cases that file does not cover:
// item-level garbage in the web node array, an uncapped web kv value, then sqlite's
// unguarded per-row parse plus its unbounded read. WebStorage runs on a Map-backed
// localStorage stub. SqliteStorage runs on an injected fake database so no native
// module is needed under jest.
import type { BondNode } from "../../model/node";
import { WebStorage } from "../web";
import { SqliteStorage } from "../sqlite";
import { generateKeypair, type RawKeypair } from "../../identity/keys";
import { makeNode } from "../../model/factory";
import { signNode, verifyNode } from "../../identity/sign";

function withRaw(seed: Record<string, string>): WebStorage {
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

// An unsigned fixture node stands in for a legacy or agent node. Those use a non-did:key did
// (did:bond:...), which the trust gate keeps while unsigned, so a valid survivor here isolates
// the F05 shape and corrupt-row behavior from the signature policy.
function goodNode(id: string, roomId: string, lamport: number): BondNode {
  return {
    id,
    roomId,
    parentId: null,
    lamport,
    createdAt: new Date(0).toISOString(),
    author: { did: "did:bond:legacy", displayName: "A", kind: "agent" },
    type: "text",
    payload: { body: id },
  };
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("F05 web adapter survives item-level garbage in the node array", () => {
  it("drops null items so an ordered read does not throw", async () => {
    const store = withRaw({ "bond:nodes:r1": "[null,null]" });
    await expect(store.nodesForRoom("r1")).resolves.toEqual([]);
  });

  it("drops shapeless object items so the author read does not throw", async () => {
    const store = withRaw({ "bond:nodes:r1": "[{},{}]" });
    await expect(store.nodesForRoom("r1")).resolves.toEqual([]);
  });

  it("drops primitive items so compareNodes does not throw", async () => {
    const store = withRaw({ "bond:nodes:r1": "[1,2,3]" });
    await expect(store.nodesForRoom("r1")).resolves.toEqual([]);
  });

  it("keeps the valid nodes then drops the junk mixed in", async () => {
    const good = goodNode("ok", "r1", 1);
    const store = withRaw({ "bond:nodes:r1": JSON.stringify([null, good, {}, 7]) });
    const back = await store.nodesForRoom("r1");
    expect(back.map((n) => n.id)).toEqual(["ok"]);
  });

  it("does not throw in maxLamport when a null item is seeded", async () => {
    const store = withRaw({ "bond:nodes:r1": "[null]" });
    await expect(store.maxLamport("r1")).resolves.toBe(0);
  });

  it("still reads a well-formed signed node back as verified", async () => {
    const kp: RawKeypair = generateKeypair();
    const signer = { did: kp.did, displayName: "S", kind: "human" as const };
    const n = makeNode({
      roomId: "r1",
      parentId: null,
      author: signer,
      type: "text",
      payload: { body: "hi" },
      lamport: 1,
    });
    n.id = "s1";
    n.sig = signNode(n, kp.secretKey);
    const store = withRaw({ "bond:nodes:r1": JSON.stringify([n]) });
    const back = await store.nodesForRoom("r1");
    expect(back.map((x) => x.id)).toEqual(["s1"]);
    expect(verifyNode(back[0])).toBe("verified");
  });
});

describe("F05 web adapter caps an oversized kv value", () => {
  it("reads an over-ceiling kv value as absent instead of parsing it whole", async () => {
    const huge = JSON.stringify("x".repeat(1_000_001));
    const store = withRaw({ "bond:kv:big": huge });
    await expect(store.getItem("big")).resolves.toBeNull();
  });

  it("still round-trips a normal kv value", async () => {
    const store = withRaw({ "bond:kv:cfg": JSON.stringify({ a: 1 }) });
    await expect(store.getItem("cfg")).resolves.toEqual({ a: 1 });
  });
});

// ---- SqliteStorage driven through an injected fake database ----
interface Captured {
  sql: string;
  params: readonly unknown[];
}

function fakeDb(opts: { all?: { json: string }[]; first?: Record<string, unknown> | null }): {
  db: unknown;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const db = {
    getAllAsync: async (sql: string, params: readonly unknown[]) => {
      calls.push({ sql, params });
      return opts.all ?? [];
    },
    getFirstAsync: async (sql: string, params: readonly unknown[]) => {
      calls.push({ sql, params });
      return opts.first ?? null;
    },
    runAsync: async (sql: string, params: readonly unknown[]) => {
      calls.push({ sql, params });
    },
    execAsync: async () => {},
  };
  return { db, calls };
}

function sqliteOn(db: unknown): SqliteStorage {
  const s = new SqliteStorage();
  (s as unknown as { dbPromise: Promise<unknown> }).dbPromise = Promise.resolve(db);
  return s;
}

describe("F05 sqlite adapter guards reads against corrupt rows then unbounded loads", () => {
  it("skips a row whose json does not parse instead of throwing", async () => {
    const good = JSON.stringify(goodNode("ok", "r1", 1));
    const { db } = fakeDb({ all: [{ json: "{ not json" }, { json: good }] });
    const back = await sqliteOn(db).nodesForRoom("r1");
    expect(back.map((n) => n.id)).toEqual(["ok"]);
  });

  it("bounds nodesForRoom with a row ceiling passed as a parameter", async () => {
    const { db, calls } = fakeDb({ all: [] });
    await sqliteOn(db).nodesForRoom("r1");
    const read = calls.find((c) => c.sql.includes("FROM nodes"));
    expect(read).toBeDefined();
    expect(read?.sql).toMatch(/LIMIT/i);
    expect(read?.params).toContain(100_000);
  });

  it("returns null for a corrupt kv value instead of throwing", async () => {
    const { db } = fakeDb({ first: { v: "{ not json" } });
    await expect(sqliteOn(db).getItem("cfg")).resolves.toBeNull();
  });
});


