import type { BondNode, Identity } from "../../model/node";
import { branchToLeaf, createSignedNode, maxLamport } from "../engine";
import { generateKeypair } from "../../identity/keys";
import { verifyNode } from "../../identity/sign";

const alice: Identity = { did: "did:key:zAlice", displayName: "Alice", kind: "human" };

function n(id: string, parentId: string | null, lamport: number): BondNode {
  return {
    id,
    roomId: "r",
    parentId,
    lamport,
    createdAt: new Date(0).toISOString(),
    author: alice,
    type: "text",
    payload: { body: id },
  };
}

describe("state engine", () => {
  it("branchToLeaf returns the path from root to leaf", () => {
    const nodes = [n("root", null, 1), n("a", "root", 2), n("a1", "a", 3), n("b", "root", 2)];
    expect(branchToLeaf(nodes, "a1").map((x) => x.id)).toEqual(["root", "a", "a1"]);
  });

  it("maxLamport finds the highest value", () => {
    expect(maxLamport([n("a", null, 3), n("b", null, 7), n("c", null, 5)])).toBe(7);
    expect(maxLamport([])).toBe(0);
  });

  it("createSignedNode produces a node that verifies", () => {
    const kp = generateKeypair();
    const author: Identity = { did: kp.did, displayName: "Me", kind: "human" };
    const node = createSignedNode(
      { roomId: "r", parentId: null, author, type: "text", payload: { body: "hi" }, lamport: 1 },
      kp.secretKey,
    );
    expect(node.sig?.signer).toBe(kp.did);
    expect(verifyNode(node)).toBe("verified");
  });

  it("populates every now-signed field before signing, so a rich node verifies", () => {
    const kp = generateKeypair();
    const author: Identity = { did: kp.did, displayName: "Me", kind: "human" };
    const node = createSignedNode(
      {
        roomId: "r",
        parentId: "p",
        author,
        type: "text",
        payload: { body: "hi" },
        lamport: 4,
        topicId: "t-1",
        causalParent: "c-1",
        forkKind: "subagent",
        collapsedByDefault: true,
        refs: [
          { kind: "depends_on", target: "x" },
          { kind: "handoff", target: "y" },
        ],
      },
      kp.secretKey,
    );
    // The structural and semantic fields are all present on the node and inside the signature,
    // so a storage read-back verifies rather than reading as tampered.
    expect(node.topicId).toBe("t-1");
    expect(node.causalParent).toBe("c-1");
    expect(node.forkKind).toBe("subagent");
    expect(node.collapsedByDefault).toBe(true);
    expect(node.refs).toHaveLength(2);
    expect(verifyNode(node)).toBe("verified");
  });

  it("detects a tampered edge after signing", () => {
    const kp = generateKeypair();
    const author: Identity = { did: kp.did, displayName: "Me", kind: "human" };
    const node = createSignedNode(
      {
        roomId: "r",
        parentId: null,
        author,
        type: "text",
        payload: { body: "hi" },
        lamport: 1,
        refs: [{ kind: "depends_on", target: "x" }],
      },
      kp.secretKey,
    );
    const tampered = { ...node, refs: [{ kind: "depends_on" as const, target: "z" }] };
    expect(verifyNode(tampered)).toBe("tampered");
  });

  it("binds the full author identity into the signature, so a relabel is tampered", () => {
    // createSignedNode must set every signed field, now including the author display name
    // and kind, before signing. So an honest node verifies. A relay that keeps the did but
    // rewrites the shown name or the human/agent flag is detected.
    const kp = generateKeypair();
    const author: Identity = { did: kp.did, displayName: "Me", kind: "human" };
    const node = createSignedNode(
      { roomId: "r", parentId: null, author, type: "text", payload: { body: "hi" }, lamport: 1 },
      kp.secretKey,
    );
    expect(verifyNode(node)).toBe("verified");
    const relabeled = { ...node, author: { ...node.author, displayName: "Admin" } };
    expect(verifyNode(relabeled)).toBe("tampered");
    const reflagged = { ...node, author: { ...node.author, kind: "agent" as const } };
    expect(verifyNode(reflagged)).toBe("tampered");
  });
});
