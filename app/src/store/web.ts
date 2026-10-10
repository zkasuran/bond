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
// A single key-value entry holds small app state (room metadata, flags, bridge config). A
// value past this is treated as corrupt or hostile then read as absent, never parsed whole.
const MAX_KV_VALUE_CHARS = 1_000_000;

/** Parse a JSON array from untrusted storage. Returns [] on anything that is not a
 *  well-formed array. Truncates to `cap` so a huge value cannot exhaust memory. When an item
 *  guard is given, each item is validated and the junk is dropped, so a well-formed array of
 *  malformed items (for example [null,null] or [{}]) can never reach a read path that
 *  dereferences a node's fields. */
function parseArray<T>(raw: string | null, cap: number, isItem?: (x: unknown) => x is T): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const items: unknown[] = parsed.length > cap ? parsed.slice(0, cap) : parsed;
    if (!isItem) return items as T[];
    return items.filter(isItem);
  } catch {
    return [];
  }
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

/** True when a parsed item carries the minimum shape every read path dereferences: a
 *  non-empty string id and roomId, a finite lamport, a null or string parentId, then an
 *  author.did string. compareNodes, maxLamport then presentableOnRead all read these, so an
 *  item that fails this is dropped before it can throw. */
function isStoredNode(x: unknown): x is BondNode {
  if (!x || typeof x !== "object") return false;
  const n = x as Record<string, unknown>;
  if (typeof n.id !== "string" || n.id.length === 0) return false;
  if (typeof n.roomId !== "string") return false;
  if (typeof n.lamport !== "number" || !Number.isFinite(n.lamport)) return false;
  if (!(n.parentId === null || typeof n.parentId === "string")) return false;
  const author = n.author as Record<string, unknown> | undefined;
  if (!author || typeof author.did !== "string") return false;
  return true;
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
    return parseArray<BondNode>(
      store.getItem(NODES_PREFIX + roomId),
      MAX_NODES_PER_ROOM,
      isStoredNode,
    );
  }

  private writeNodes(store: WebStore, roomId: string, nodes: BondNode[]): void {
    store.setItem(NODES_PREFIX + roomId, JSON.stringify(nodes));
  }

  private readRooms(store: WebStore): string[] {
    return parseArray<string>(store.getItem(ROOMS_KEY), MAX_ROOMS, isString);
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
    return parseArray<string>(store.getItem(KV_INDEX_KEY), MAX_KV_KEYS, isString);
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
    if (raw.length > MAX_KV_VALUE_CHARS) return null; // an over-ceiling value reads as absent
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
