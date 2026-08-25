// Small, testable helpers that sit between the pure model and the stateful store.
import type { BondNode, MessageType } from "../model/node";
import type { PayloadMap } from "../model/messages";
import { buildForest, pathToRoot } from "../model/thread";
import { makeNode, type NewNodeInput } from "../model/factory";
import { signNode } from "../identity/sign";

/** The nodes on the path from the room root down to a leaf, root first. This is the
 *  context an agent sees when it is mentioned deep in a branch. */
export function branchToLeaf(nodes: BondNode[], leafId: string): BondNode[] {
  const forest = buildForest(nodes);
  const ids = pathToRoot(leafId, forest).reverse();
  return ids
    .map((id) => forest.byId.get(id))
    .filter((n): n is BondNode => n !== undefined);
}

/** Highest Lamport value across a set of nodes, 0 if empty. */
export function maxLamport(nodes: BondNode[]): number {
  let max = 0;
  for (const n of nodes) if (n.lamport > max) max = n.lamport;
  return max;
}

/**
 * Mint a node authored by the local human and sign it. Only the local user's own nodes
 * are signed: the signer must equal the author, so agent messages stay unsigned (the
 * honest neutral badge) unless Bond issues a separate receipt.
 */
export function createSignedNode<K extends MessageType>(
  input: NewNodeInput<K>,
  secretKey: Uint8Array,
): BondNode<PayloadMap[K]> {
  const node = makeNode(input);
  node.sig = signNode(node, secretKey);
  return node;
}
