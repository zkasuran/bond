// Pure tree and ordering operations over the node graph. No IO, no deps beyond the
// model types, so this is the most heavily unit-tested part of Bond. See DESIGN.md sec 2.
import type { BondNode } from "./node";
import type { TokenDeltaPayload, TypedNode } from "./messages";

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

/** All nodes in the subtree rooted at rootId, root first, pre-order. */
export function collectSubtree(rootId: string, forest: Forest): BondNode[] {
  const out: BondNode[] = [];
  const root = forest.byId.get(rootId);
  if (!root) return out;
  const stack: BondNode[] = [root];
  while (stack.length) {
    const n = stack.pop() as BondNode;
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
 *  collapsed node still renders; its subtree is skipped and counted. Pure, so the UI
 *  stays dumb and this stays testable. */
export function flattenForRender(
  forest: Forest,
  collapsed: ReadonlySet<string> = new Set(),
): RenderRow[] {
  const rows: RenderRow[] = [];
  const walk = (node: BondNode, depth: number) => {
    const kids = forest.childrenOf.get(node.id) ?? [];
    const isCollapsed =
      collapsed.has(node.id) || (node.collapsedByDefault && !collapsed.has("!" + node.id));
    if (isCollapsed && kids.length) {
      rows.push({ node, depth, hiddenCount: collectSubtree(node.id, forest).length - 1 });
      return;
    }
    rows.push({ node, depth, hiddenCount: 0 });
    for (const k of kids) walk(k, depth + 1);
  };
  for (const r of forest.roots) walk(r, 0);
  return rows;
}

/** Concatenate token_delta nodes for one streaming target on a channel, in seq order. */
export function assembleTokenStream(
  deltas: TypedNode<"token_delta">[],
  channel: NonNullable<TokenDeltaPayload["channel"]> = "text",
): { text: string; done: boolean } {
  const rel = deltas
    .filter((d) => (d.payload.channel ?? "text") === channel)
    .sort((a, b) => a.payload.seq - b.payload.seq);
  return {
    text: rel.map((d) => d.payload.delta).join(""),
    done: rel.some((d) => d.payload.done === true),
  };
}
