// Web Storage adapter, backed by the browser localStorage. The node log is kept as a
// per-room JSON array under "bond:nodes:<roomId>", run through the trust gate in guard.ts
// on write so it matches the grow-only log the other adapters give. Room ids are tracked
// in a small index so roomIds does not have to scan every key. The key-value area lives
// under "bond:kv:". localStorage is untrusted input: every read parses defensively and
// caps its length, so a corrupted or hostile key degrades to empty instead of throwing.
// If localStorage is missing (SSR, a non-browser test) every read is empty and every
// write is a no-op, so the app degrades instead of throwing. See DESIGN.md sec 9.
import type { BondNode } from "../model/node";
import { compareNodes } from "../model/thread";
import { decideIngest, presentableOnRead } from "./guard";
import type { Storage } from "./types";

const NODES_PREFIX = "bond:nodes:";
const ROOMS_KEY = "bond:rooms";
const KV_PREFIX = "bond:kv:";
const KV_INDEX_KEY = "bond:kvkeys";

// Ceilings on anything parsed out of localStorage. A hostile or corrupted key cannot make
// the app allocate without bound; past the cap the list is truncated rather than trusted.
const MAX_NODES_PER_ROOM = 100_000;
const MAX_ROOMS = 10_000;
const MAX_KV_KEYS = 10_000;

/** Parse a JSON array from untrusted storage. Returns [] on anything that is not a
 *  well-formed array. Truncates to `cap` so a huge value cannot exhaust memory. */
function parseArray<T>(raw: string | null, cap: number): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed.length > cap ? parsed.slice(0, cap) : parsed) as T[];
  } catch {
    return [];
  }
}

/** The small slice of the localStorage API this adapter uses. */
interface WebStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class WebStorage implements Storage {
  private store(): WebStore | null {
    const g = globalThis as { localStorage?: WebStore };
    return g.localStorage ?? null;
  }

  private readNodes(store: WebStore, roomId: string): BondNode[] {
    return parseArray<BondNode>(store.getItem(NODES_PREFIX + roomId), MAX_NODES_PER_ROOM);
  }

  private writeNodes(store: WebStore, roomId: string, nodes: BondNode[]): void {
    store.setItem(NODES_PREFIX + roomId, JSON.stringify(nodes));
  }

  private readRooms(store: WebStore): string[] {
    return parseArray<string>(store.getItem(ROOMS_KEY), MAX_ROOMS);
  }

  private trackRoom(store: WebStore, roomId: string): void {
    const rooms = this.readRooms(store);
    if (!rooms.includes(roomId)) {
      rooms.push(roomId);
      store.setItem(ROOMS_KEY, JSON.stringify(rooms));
    }
  }

  async append(node: BondNode): Promise<void> {
    const store = this.store();
    if (!store) return;
    const nodes = this.readNodes(store, node.roomId);
    const idx = nodes.findIndex((n) => n.id === node.id);
    const outcome = decideIngest(idx === -1 ? undefined : nodes[idx], node);
    if (outcome === "store") {
      if (idx === -1) nodes.push(node);
      else nodes[idx] = node;
      this.writeNodes(store, node.roomId, nodes);
    }
    this.trackRoom(store, node.roomId);
  }

  async appendMany(nodes: BondNode[]): Promise<void> {
    const store = this.store();
    if (!store) return;
    // Group by room so each room's array is read and written once.
    const byRoom = new Map<string, BondNode[]>();
    for (const n of nodes) {
      const arr = byRoom.get(n.roomId);
      if (arr) arr.push(n);
      else byRoom.set(n.roomId, [n]);
    }
    for (const [roomId, incoming] of byRoom) {
      const existing = this.readNodes(store, roomId);
      const indexById = new Map<string, number>();
      existing.forEach((n, i) => indexById.set(n.id, i));
      for (const n of incoming) {
        const at = indexById.get(n.id);
        const outcome = decideIngest(at === undefined ? undefined : existing[at], n);
        if (outcome !== "store") continue;
        if (at === undefined) {
          indexById.set(n.id, existing.length);
          existing.push(n);
        } else {
          existing[at] = n;
        }
      }
      this.writeNodes(store, roomId, existing);
      this.trackRoom(store, roomId);
    }
  }

  async nodesForRoom(roomId: string): Promise<BondNode[]> {
    const store = this.store();
    if (!store) return [];
    return this.readNodes(store, roomId).filter(presentableOnRead).sort(compareNodes);
  }

  async maxLamport(roomId: string): Promise<number> {
    const store = this.store();
    if (!store) return 0;
    let max = 0;
    for (const n of this.readNodes(store, roomId)) {
      if (n.lamport > max) max = n.lamport;
    }
    return max;
  }

  async roomIds(): Promise<string[]> {
    const store = this.store();
    if (!store) return [];
    return this.readRooms(store);
  }

  private readKvKeys(store: WebStore): string[] {
    return parseArray<string>(store.getItem(KV_INDEX_KEY), MAX_KV_KEYS);
  }

  private trackKvKey(store: WebStore, key: string): void {
    const keys = this.readKvKeys(store);
    if (!keys.includes(key)) {
      keys.push(key);
      store.setItem(KV_INDEX_KEY, JSON.stringify(keys));
    }
  }

  private untrackKvKey(store: WebStore, key: string): void {
    const keys = this.readKvKeys(store);
    const next = keys.filter((k) => k !== key);
    if (next.length !== keys.length) {
      store.setItem(KV_INDEX_KEY, JSON.stringify(next));
    }
  }

  async getItem<T = unknown>(key: string): Promise<T | null> {
    const store = this.store();
    if (!store) return null;
    const raw = store.getItem(KV_PREFIX + key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupted or hostile value reads as absent rather than throwing.
      return null;
    }
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    const store = this.store();
    if (!store) return;
    store.setItem(KV_PREFIX + key, JSON.stringify(value));
    this.trackKvKey(store, key);
  }

  async removeItem(key: string): Promise<void> {
    const store = this.store();
    if (!store) return;
    store.removeItem(KV_PREFIX + key);
    this.untrackKvKey(store, key);
  }

  async clear(): Promise<void> {
    const store = this.store();
    if (!store) return;
    for (const roomId of this.readRooms(store)) {
      store.removeItem(NODES_PREFIX + roomId);
    }
    store.removeItem(ROOMS_KEY);
    for (const key of this.readKvKeys(store)) {
      store.removeItem(KV_PREFIX + key);
    }
    store.removeItem(KV_INDEX_KEY);
  }
}
