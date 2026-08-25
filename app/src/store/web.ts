// Web Storage adapter, backed by the browser localStorage. The node log is kept as a
// per-room JSON array under "bond:nodes:<roomId>", deduped by id on write so it matches
// the grow-only log the other adapters give. Room ids are tracked in a small index so
// roomIds does not have to scan every key. The key-value area lives under "bond:kv:".
// If localStorage is missing (SSR, a non-browser test) every read is empty and every
// write is a no-op, so the app degrades instead of throwing. See DESIGN.md sec 9.
import type { BondNode } from "../model/node";
import { compareNodes } from "../model/thread";
import type { Storage } from "./types";

const NODES_PREFIX = "bond:nodes:";
const ROOMS_KEY = "bond:rooms";
const KV_PREFIX = "bond:kv:";
const KV_INDEX_KEY = "bond:kvkeys";

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
    const raw = store.getItem(NODES_PREFIX + roomId);
    if (!raw) return [];
    return JSON.parse(raw) as BondNode[];
  }

  private writeNodes(store: WebStore, roomId: string, nodes: BondNode[]): void {
    store.setItem(NODES_PREFIX + roomId, JSON.stringify(nodes));
  }

  private readRooms(store: WebStore): string[] {
    const raw = store.getItem(ROOMS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
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
    if (!nodes.some((n) => n.id === node.id)) {
      nodes.push(node);
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
      const seen = new Set(existing.map((n) => n.id));
      for (const n of incoming) {
        if (!seen.has(n.id)) {
          existing.push(n);
          seen.add(n.id);
        }
      }
      this.writeNodes(store, roomId, existing);
      this.trackRoom(store, roomId);
    }
  }

  async nodesForRoom(roomId: string): Promise<BondNode[]> {
    const store = this.store();
    if (!store) return [];
    return this.readNodes(store, roomId).sort(compareNodes);
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
    const raw = store.getItem(KV_INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
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
    return JSON.parse(raw) as T;
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
