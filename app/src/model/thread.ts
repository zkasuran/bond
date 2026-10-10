// Pure tree and ordering operations over the node graph. No IO, no deps beyond the
// model types, so this is the most heavily unit-tested part of Bond. See DESIGN.md sec 2.
import type { BondNode } from "./node";
import type { TokenDeltaPayload, TypedNode } from "./messages";
import { isValidPayload } from "./messages";

/** Hard ceiling on render depth. A relayed set of validly signed nodes can form an
 *  arbitrarily deep parent chain, so flattenForRender walks with an explicit stack, never
 *  the call stack. It stops descending past this depth. A real thread never approaches it,
 *  so this only caps a hostile chain that would otherwise overflow the stack and blank the
 *  room. */
const MAX_RENDER_DEPTH = 10_000;

/**
 * Total order consistent with causality: Lamport clock first, ties broken by signer
 * did then id. createdAt is never used for ordering.
 */
export function compareNodes(a: BondNode, b: BondNode): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.author.did !== b.author.did) return a.author.did < b.author.did ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** A new node's Lamport value is one past the highest it is causally after. */
export function nextLamport(...seen: number[]): number {
  let max = 0;
  for (const s of seen) if (s > max) max = s;
  return max + 1;
}

export interface Forest {
  byId: Map<string, BondNode>;
  /** parentId -> children ordered by compareNodes. */
  childrenOf: Map<string, BondNode[]>;
  /** nodes with no parent, or whose parent is not present yet (orphans render too). */
  roots: BondNode[];
}

/** Build the spanning tree from a flat node list. A node whose parent is absent is
 *  treated as a root so a partially synced log still renders. */
export function buildForest(nodes: BondNode[]): Forest {
  const byId = new Map<string, BondNode>();
  for (const n of nodes) byId.set(n.id, n);

  const childrenOf = new Map<string, BondNode[]>();
  const roots: BondNode[] = [];
  for (const n of nodes) {
    if (n.parentId === null || !byId.has(n.parentId)) {
      roots.push(n);
    } else {
      const arr = childrenOf.get(n.parentId);
      if (arr) arr.push(n);
      else childrenOf.set(n.parentId, [n]);
    }
  }
  for (const arr of childrenOf.values()) arr.sort(compareNodes);
  roots.sort(compareNodes);
  return { byId, childrenOf, roots };
}

/** All nodes in the subtree rooted at rootId, root first, pre-order. A visited set guards
 *  against an adversarial parentId cycle (the same guard pathToRoot has), so a crafted
 *  log cannot hang the render by looping two nodes as each other's parent. */
export function collectSubtree(rootId: string, forest: Forest): BondNode[] {
  const out: BondNode[] = [];
  const root = forest.byId.get(rootId);
  if (!root) return out;
  const visited = new Set<string>();
  const stack: BondNode[] = [root];
  while (stack.length) {
    const n = stack.pop() as BondNode;
    if (visited.has(n.id)) continue;
    visited.add(n.id);
    out.push(n);
    const kids = forest.childrenOf.get(n.id);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/** Node ids from a node up to its root, nearest first. */
export function pathToRoot(nodeId: string, forest: Forest): string[] {
  const path: string[] = [];
  let cur = forest.byId.get(nodeId);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    path.push(cur.id);
    guard.add(cur.id);
    cur = cur.parentId ? forest.byId.get(cur.parentId) : undefined;
  }
  return path;
}

export interface RenderRow {
  node: BondNode;
  depth: number;
  /** number of descendants hidden because this node is collapsed. */
  hiddenCount: number;
}

/** Flatten the forest into an ordered render list, honoring a collapsed set. A
 *  collapsed node still renders; its subtree is skipped and counted. Walks with an explicit
 *  stack and a depth cap, so a long parent chain cannot overflow the call stack. Pure, so
 *  the UI stays dumb and this stays testable. */
export function flattenForRender(
  forest: Forest,
  collapsed: ReadonlySet<string> = new Set(),
): RenderRow[] {
  const rows: RenderRow[] = [];
  const stack: { node: BondNode; depth: number }[] = [];
  // Push roots in reverse so the first root is processed first, pre-order.
  for (let i = forest.roots.length - 1; i >= 0; i--) {
    stack.push({ node: forest.roots[i], depth: 0 });
  }
  while (stack.length) {
    const { node, depth } = stack.pop() as { node: BondNode; depth: number };
    const kids = forest.childrenOf.get(node.id) ?? [];
    const isCollapsed =
      collapsed.has(node.id) || (node.collapsedByDefault && !collapsed.has("!" + node.id));
    if (isCollapsed && kids.length) {
      rows.push({ node, depth, hiddenCount: collectSubtree(node.id, forest).length - 1 });
      continue;
    }
    rows.push({ node, depth, hiddenCount: 0 });
    // Stop descending past the cap. Children are pushed in reverse so the leftmost renders
    // next, which reproduces the pre-order a recursive walk gave.
    if (depth < MAX_RENDER_DEPTH) {
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], depth: depth + 1 });
    }
  }
  return rows;
}

/** Concatenate token_delta nodes for one streaming target on a channel, in seq order. A
 *  node's payload is signed but still attacker-chosen, so a delta whose payload is not a
 *  valid token_delta shape is skipped rather than dereferenced. */
export function assembleTokenStream(
  deltas: TypedNode<"token_delta">[],
  channel: NonNullable<TokenDeltaPayload["channel"]> = "text",
): { text: string; done: boolean } {
  const rel = deltas
    .filter((d) => isValidPayload("token_delta", d.payload))
    .filter((d) => (d.payload.channel ?? "text") === channel)
    .sort((a, b) => a.payload.seq - b.payload.seq);
  return {
    text: rel.map((d) => d.payload.delta).join(""),
    done: rel.some((d) => d.payload.done === true),
  };
}
