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
});
