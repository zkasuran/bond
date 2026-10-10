// Native Storage adapter, backed by expo-sqlite. The node log lives in one table
// keyed by id. Writes and reads run through the trust gate in guard.ts: an incoming node
// is verified and deduped on content before it is written. A tampered node is never
// returned. Ordering is done in JS with compareNodes so the total order stays defined in
// one place (the model), not split across SQL. See DESIGN.md sec 9.
import * as SQLite from "expo-sqlite";
import type { BondNode } from "../model/node";
import { compareNodes } from "../model/thread";
import { decideIngest, presentableOnRead } from "./guard";
import type { Storage } from "./types";

type NodeRow = { json: string };
type MaxRow = { m: number | null };
type KvRow = { v: string };
type RoomRow = { roomId: string };

// Row ceiling for one room read, mirroring the web adapter's MAX_NODES_PER_ROOM. A flooded
// room cannot pull an unbounded result set into memory. Defined here, not imported from
// web.ts, so the native bundle never drags in the localStorage adapter.
const MAX_NODES_PER_ROOM = 100_000;

export class SqliteStorage implements Storage {
  private dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

  constructor(private readonly databaseName = "bond.db") {}

  /** Open the database once and reuse it. The CREATE TABLE runs on first open. */
  private db(): Promise<SQLite.SQLiteDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const db = await SQLite.openDatabaseAsync(this.databaseName);
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            roomId TEXT,
            lamport INTEGER,
            json TEXT
          );
          CREATE INDEX IF NOT EXISTS nodes_room ON nodes (roomId);
          CREATE TABLE IF NOT EXISTS kv (
            k TEXT PRIMARY KEY,
            v TEXT
          );
        `);
        return db;
      })();
    }
    return this.dbPromise;
  }

  /** Read one stored node by id. Returns undefined when absent. Used to resolve a
   *  dedupe conflict. */
  private async nodeById(
    db: SQLite.SQLiteDatabase,
    id: string,
  ): Promise<BondNode | undefined> {
    const row = await db.getFirstAsync<NodeRow>("SELECT json FROM nodes WHERE id = ?", [id]);
    if (!row) return undefined;
    try {
      return JSON.parse(row.json) as BondNode;
    } catch {
      return undefined;
    }
  }

  async append(node: BondNode): Promise<void> {
    const db = await this.db();
    const existing = await this.nodeById(db, node.id);
    if (decideIngest(existing, node) !== "store") return;
    await db.runAsync(
      "INSERT OR REPLACE INTO nodes (id, roomId, lamport, json) VALUES (?, ?, ?, ?)",
      [node.id, node.roomId, node.lamport, JSON.stringify(node)],
    );
  }

  async appendMany(nodes: BondNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const db = await this.db();
    for (const n of nodes) {
      const existing = await this.nodeById(db, n.id);
      if (decideIngest(existing, n) !== "store") continue;
      await db.runAsync(
        "INSERT OR REPLACE INTO nodes (id, roomId, lamport, json) VALUES (?, ?, ?, ?)",
        [n.id, n.roomId, n.lamport, JSON.stringify(n)],
      );
    }
  }

  async nodesForRoom(roomId: string): Promise<BondNode[]> {
    const db = await this.db();
    const rows = await db.getAllAsync<NodeRow>(
      "SELECT json FROM nodes WHERE roomId = ? ORDER BY lamport LIMIT ?",
      [roomId, MAX_NODES_PER_ROOM],
    );
    const nodes: BondNode[] = [];
    for (const r of rows) {
      let node: BondNode;
      try {
        node = JSON.parse(r.json) as BondNode;
      } catch {
        continue; // a corrupt row (on-disk tamper, schema drift) is skipped, not fatal
      }
      if (presentableOnRead(node)) nodes.push(node);
    }
    return nodes.sort(compareNodes);
  }

  async maxLamport(roomId: string): Promise<number> {
    const db = await this.db();
    const row = await db.getFirstAsync<MaxRow>(
      "SELECT MAX(lamport) AS m FROM nodes WHERE roomId = ?",
      [roomId],
    );
    return row?.m ?? 0;
  }

  async roomIds(): Promise<string[]> {
    const db = await this.db();
    const rows = await db.getAllAsync<RoomRow>("SELECT DISTINCT roomId FROM nodes");
    return rows.map((r) => r.roomId);
  }

  async getItem<T = unknown>(key: string): Promise<T | null> {
    const db = await this.db();
    const row = await db.getFirstAsync<KvRow>("SELECT v FROM kv WHERE k = ?", [key]);
    if (!row) return null;
    try {
      return JSON.parse(row.v) as T;
    } catch {
      return null; // a corrupt kv cell reads as absent rather than throwing the whole read
    }
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    const db = await this.db();
    await db.runAsync("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", [
      key,
      JSON.stringify(value),
    ]);
  }

  async removeItem(key: string): Promise<void> {
    const db = await this.db();
    await db.runAsync("DELETE FROM kv WHERE k = ?", [key]);
  }

  async clear(): Promise<void> {
    const db = await this.db();
    await db.execAsync("DELETE FROM nodes; DELETE FROM kv;");
  }
}
