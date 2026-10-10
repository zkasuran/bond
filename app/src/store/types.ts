// Storage port. Two responsibilities: an append-only BondNode log (the conversation
// CRDT) and a small key-value area for app state (room metadata, memberships, bridge
// configs, flags). Platform adapters implement it: memory (tests), sqlite (native),
// web (localStorage). See DESIGN.md sec 9.
import type { BondNode } from "../model/node";

export interface Storage {
  /** Append one node. A byte-identical duplicate is ignored so the log stays a
   *  conflict-free union. A node whose signature does not verify is dropped. An unsigned
   *  node that claims a did:key author is dropped too, since a genuine did:key node is
   *  always signed. A forged node reusing an id with different content cannot shadow the one
   *  already stored. */
  append(node: BondNode): Promise<void>;
  appendMany(nodes: BondNode[]): Promise<void>;
  /** All nodes in a room, ordered by the causal total order. Tampered nodes and unsigned
   *  nodes claiming a did:key author are not returned, so a verified badge is never shown
   *  over altered bytes or an injected victim identity. */
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
