// Storage port. Two responsibilities: an append-only BondNode log (the conversation
// CRDT) and a small key-value area for app state (room metadata, memberships, bridge
// configs, flags). Platform adapters implement it: memory (tests), sqlite (native),
// web (localStorage). See DESIGN.md sec 9.
import type { BondNode } from "../model/node";

export interface Storage {
  /** Append one node. Duplicates by id are ignored, so sync is a conflict-free union. */
  append(node: BondNode): Promise<void>;
  appendMany(nodes: BondNode[]): Promise<void>;
  /** All nodes in a room, ordered by the causal total order. */
  nodesForRoom(roomId: string): Promise<BondNode[]>;
  /** Highest Lamport value seen for a room, 0 if none. Used to resume sync. */
  maxLamport(roomId: string): Promise<number>;
  roomIds(): Promise<string[]>;

  getItem<T = unknown>(key: string): Promise<T | null>;
  setItem<T = unknown>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;

  /** Wipe everything. Test and sign-out use only. */
  clear(): Promise<void>;
}
