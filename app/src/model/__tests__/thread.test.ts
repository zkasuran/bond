import type { BondNode, Identity } from "../node";
import type { TypedNode } from "../messages";
import { isType } from "../messages";
import {
  compareNodes,
  nextLamport,
  buildForest,
  collectSubtree,
  flattenForRender,
  assembleTokenStream,
} from "../thread";

const alice: Identity = { did: "did:key:zAlice", displayName: "Alice", kind: "human" };

function node(
  id: string,
  parentId: string | null,
  lamport: number,
  extra: Partial<BondNode> = {},
): BondNode {
  return {
    id,
    roomId: "r",
    parentId,
    lamport,
    createdAt: new Date(0).toISOString(),
    author: alice,
    type: "text",
    payload: { body: id },
    ...extra,
  };
}

describe("lamport ordering", () => {
  it("nextLamport is one past the highest seen, and 1 from empty", () => {
    expect(nextLamport(3, 5, 2)).toBe(6);
    expect(nextLamport()).toBe(1);
  });

  it("orders by lamport, then did, then id", () => {
    const a = node("a", null, 1);
    const b = node("b", null, 2);
    expect(compareNodes(a, b)).toBeLessThan(0);
    const c = node("c", null, 2);
    const d = node("d", null, 2);
    expect(compareNodes(c, d)).toBeLessThan(0); // same lamport + did, id breaks tie
  });
});

describe("forest building", () => {
  it("builds a tree, sorts children, and treats an orphan as a root", () => {
    const nodes = [
      node("root", null, 1),
      node("c2", "root", 3),
      node("c1", "root", 2),
      node("orphan", "missing", 5),
    ];
    const forest = buildForest(nodes);
    expect(forest.roots.map((n) => n.id).sort()).toEqual(["orphan", "root"]);
    expect(forest.childrenOf.get("root")!.map((n) => n.id)).toEqual(["c1", "c2"]);
  });

  it("collectSubtree walks a subtree pre-order, root first", () => {
    const nodes = [
      node("root", null, 1),
      node("a", "root", 2),
      node("a1", "a", 3),
      node("b", "root", 4),
    ];
    const forest = buildForest(nodes);
    expect(collectSubtree("root", forest).map((n) => n.id)).toEqual(["root", "a", "a1", "b"]);
    expect(collectSubtree("a", forest).map((n) => n.id)).toEqual(["a", "a1"]);
  });

  it("collectSubtree does not hang on an adversarial parentId cycle", () => {
    // Two nodes name each other as parent. buildForest wires each as the other's child,
    // so a naive walk would loop forever. The visited guard must terminate it.
    const nodes = [node("x", "y", 1), node("y", "x", 2)];
    const forest = buildForest(nodes);
    const out = collectSubtree("x", forest).map((n) => n.id);
    expect(out).toContain("x");
    expect(out).toContain("y");
    expect(out.length).toBe(2);
  });

  it("collectSubtree does not hang on a self-parent cycle", () => {
    const nodes = [node("s", "s", 1)];
    const forest = buildForest(nodes);
    expect(collectSubtree("s", forest).map((n) => n.id)).toEqual(["s"]);
  });
});

describe("flattenForRender", () => {
  it("hides a collapsed subtree and counts the hidden nodes", () => {
    const nodes = [
      node("root", null, 1),
      node("a", "root", 2),
      node("a1", "a", 3),
      node("a2", "a", 4),
    ];
    const forest = buildForest(nodes);
    const open = flattenForRender(forest, new Set());
    expect(open.map((r) => r.node.id)).toEqual(["root", "a", "a1", "a2"]);
    const collapsed = flattenForRender(forest, new Set(["a"]));
    expect(collapsed.map((r) => r.node.id)).toEqual(["root", "a"]);
    expect(collapsed.find((r) => r.node.id === "a")!.hiddenCount).toBe(2);
  });
});

describe("assembleTokenStream", () => {
  it("concatenates deltas in seq order and reports done", () => {
    const deltas: TypedNode<"token_delta">[] = [
      { ...node("d2", "t", 3), type: "token_delta", payload: { targetId: "t", seq: 2, delta: "world", done: true } },
      { ...node("d1", "t", 2), type: "token_delta", payload: { targetId: "t", seq: 1, delta: "hello " } },
    ];
    const out = assembleTokenStream(deltas);
    expect(out.text).toBe("hello world");
    expect(out.done).toBe(true);
  });

  it("ignores a delta whose payload is null instead of throwing", () => {
    // A validly signed node can carry type token_delta with a null payload. Stream assembly
    // must skip it, not dereference it and crash the room.
    const good = {
      ...node("d1", "t", 2),
      type: "token_delta",
      payload: { targetId: "t", seq: 1, delta: "hello" },
    } as unknown as TypedNode<"token_delta">;
    const hostile = { ...node("d2", "t", 3), type: "token_delta", payload: null } as unknown as TypedNode<"token_delta">;
    let out: { text: string; done: boolean } | undefined;
    expect(() => {
      out = assembleTokenStream([good, hostile]);
    }).not.toThrow();
    expect(out!.text).toBe("hello");
  });
});

describe("payload-shape validation", () => {
  it("isType does not narrow a node whose payload is null", () => {
    const n = { ...node("x", null, 1), type: "token_delta", payload: null } as unknown as BondNode;
    expect(isType(n, "token_delta")).toBe(false);
  });

  it("isType narrows a node whose payload matches the type", () => {
    const n = {
      ...node("x", null, 1),
      type: "token_delta",
      payload: { targetId: "t", seq: 1, delta: "hi" },
    } as unknown as BondNode;
    expect(isType(n, "token_delta")).toBe(true);
  });
});

describe("flattenForRender bounds recursion depth", () => {
  it("does not overflow the stack on a very deep parent chain", () => {
    // A relayed set of validly signed nodes can form a long linear chain. A recursive walk
    // overflows the JS call stack a few thousand deep and blanks the room. The render must
    // survive it.
    const nodes: BondNode[] = [node("n0", null, 1)];
    for (let i = 1; i < 60000; i++) nodes.push(node(`n${i}`, `n${i - 1}`, i + 1));
    const forest = buildForest(nodes);
    let rows: ReturnType<typeof flattenForRender> | undefined;
    expect(() => {
      rows = flattenForRender(forest);
    }).not.toThrow();
    expect(rows!.length).toBeGreaterThan(0);
    expect(rows!.length).toBeLessThanOrEqual(nodes.length);
  });
});
