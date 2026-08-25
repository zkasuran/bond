// In-memory Storage. Used by unit tests and as a safe fallback before a platform
// adapter is ready. Dedupes nodes by id so it behaves like the grow-only log.
import type { BondNode } from "../model/node";
import { compareNodes } from "../model/thread";
import type { Storage } from "./types";

export class MemoryStorage implements Storage {
  private nodes = new Map<string, BondNode>();
  private kv = new Map<string, unknown>();

  async append(node: BondNode): Promise<void> {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
  }

  async appendMany(nodes: BondNode[]): Promise<void> {
    for (const n of nodes) if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
  }

  async nodesForRoom(roomId: string): Promise<BondNode[]> {
    return [...this.nodes.values()]
      .filter((n) => n.roomId === roomId)
      .sort(compareNodes);
  }

  async maxLamport(roomId: string): Promise<number> {
    let max = 0;
    for (const n of this.nodes.values()) {
      if (n.roomId === roomId && n.lamport > max) max = n.lamport;
    }
    return max;
  }

  async roomIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const n of this.nodes.values()) ids.add(n.roomId);
    return [...ids];
  }

  async getItem<T = unknown>(key: string): Promise<T | null> {
    return (this.kv.get(key) as T) ?? null;
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    this.kv.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.kv.delete(key);
  }

  async clear(): Promise<void> {
    this.nodes.clear();
    this.kv.clear();
  }
}
