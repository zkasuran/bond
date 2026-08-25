// Node factory. The one place a BondNode is minted, so id, timestamp and Lamport
// assignment stay consistent. Signing is a separate step (identity/sign.ts).
import { ulid } from "ulidx";
import type { BondNode, ForkKind, Identity, MessageType, NodeRef } from "./node";
import type { PayloadMap } from "./messages";

export interface NewNodeInput<K extends MessageType> {
  roomId: string;
  parentId: string | null;
  author: Identity;
  type: K;
  payload: PayloadMap[K];
  /** Caller computes this with nextLamport(...) from the causal predecessors. */
  lamport: number;
  topicId?: string;
  causalParent?: string;
  refs?: NodeRef[];
  forkKind?: ForkKind;
  collapsedByDefault?: boolean;
}

export function makeNode<K extends MessageType>(
  input: NewNodeInput<K>,
): BondNode<PayloadMap[K]> {
  return {
    id: ulid(),
    roomId: input.roomId,
    topicId: input.topicId,
    parentId: input.parentId,
    causalParent: input.causalParent,
    refs: input.refs,
    forkKind: input.forkKind,
    lamport: input.lamport,
    createdAt: new Date().toISOString(),
    author: input.author,
    type: input.type,
    payload: input.payload,
    collapsedByDefault: input.collapsedByDefault,
  };
}
