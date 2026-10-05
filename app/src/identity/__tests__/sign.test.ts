import { generateKeypair, publicKeyToDid, didToPublicKey } from "../keys";
import { signNode, verifyNode, canonicalSubset } from "../sign";
import { makeNode } from "../../model/factory";
import { SIGNED_FIELDS } from "../../model/node";
import type { BondNode, Identity, NodeRef } from "../../model/node";

function textNode(did: string, body = "hello world") {
  const author: Identity = { did, displayName: "Ada", kind: "human" };
  return makeNode({
    roomId: "r1",
    parentId: null,
    author,
    type: "text",
    payload: { body },
    lamport: 1,
  });
}

/** A node with every optional structural and semantic field populated, then signed. */
function fullNode(did: string) {
  const author: Identity = { did, displayName: "Ada", kind: "human" };
  const refs: NodeRef[] = [
    { kind: "depends_on", target: "n-2" },
    { kind: "handoff", target: "n-9" },
  ];
  return makeNode({
    roomId: "r1",
    parentId: "root",
    author,
    type: "text",
    payload: { body: "hi" },
    lamport: 4,
    topicId: "t-1",
    causalParent: "n-prev",
    refs,
    forkKind: "subagent",
    collapsedByDefault: true,
  });
}

describe("identity and signing", () => {
  it("round-trips a did:key to the raw public key and back", () => {
    const kp = generateKeypair();
    expect(kp.did.startsWith("did:key:z")).toBe(true);
    expect(Array.from(didToPublicKey(kp.did))).toEqual(Array.from(kp.publicKey));
    expect(publicKeyToDid(kp.publicKey)).toBe(kp.did);
  });

  it("signs a node and verifies it offline", () => {
    const kp = generateKeypair();
    const node = textNode(kp.did);
    node.sig = signNode(node, kp.secretKey);
    expect(verifyNode(node)).toBe("verified");
  });

  it("reports unsigned when there is no signature", () => {
    const kp = generateKeypair();
    expect(verifyNode(textNode(kp.did))).toBe("unsigned");
  });

  it("fails a tampered payload (the falsification test)", () => {
    const kp = generateKeypair();
    const node = textNode(kp.did);
    node.sig = signNode(node, kp.secretKey);
    const tampered = { ...node, payload: { body: "hello world!" } };
    expect(verifyNode(tampered)).toBe("tampered");
  });

  it("fails when the signer did does not match the author", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const node = textNode(a.did);
    node.sig = signNode(node, a.secretKey);
    const impostor = { ...node, sig: { ...node.sig, signer: b.did } };
    expect(verifyNode(impostor)).toBe("tampered");
  });
});

describe("the signed field set is single-sourced", () => {
  it("the canonical subset keys are exactly SIGNED_FIELDS", () => {
    const kp = generateKeypair();
    const node = fullNode(kp.did);
    expect(Object.keys(canonicalSubset(node)).sort()).toEqual([...SIGNED_FIELDS].sort());
  });

  it("signs and verifies a node that carries every structural field", () => {
    const kp = generateKeypair();
    const node = fullNode(kp.did);
    node.sig = signNode(node, kp.secretKey);
    expect(verifyNode(node)).toBe("verified");
  });
});

describe("structural and semantic fields are now covered by the signature", () => {
  const kp = generateKeypair();

  function signedFull() {
    const node = fullNode(kp.did);
    node.sig = signNode(node, kp.secretKey);
    return node;
  }

  it("detects a rewritten ref (edge tampering) as tampered", () => {
    const node = signedFull();
    const tampered = { ...node, refs: [{ kind: "depends_on", target: "n-EVIL" }] as NodeRef[] };
    expect(verifyNode(tampered)).toBe("tampered");
  });

  it("detects a dropped ref as tampered", () => {
    const node = signedFull();
    const tampered = { ...node, refs: [node.refs![0]] };
    expect(verifyNode(tampered)).toBe("tampered");
  });

  it("treats a reordered ref set as unchanged (deterministic ordering)", () => {
    const node = signedFull();
    const reordered = { ...node, refs: [...node.refs!].reverse() };
    expect(verifyNode(reordered)).toBe("verified");
  });

  it("detects a flipped collapsedByDefault as tampered", () => {
    const node = signedFull();
    const tampered = { ...node, collapsedByDefault: false };
    expect(verifyNode(tampered)).toBe("tampered");
  });

  it("detects a rewritten causalParent as tampered", () => {
    const node = signedFull();
    const tampered = { ...node, causalParent: "n-OTHER" };
    expect(verifyNode(tampered)).toBe("tampered");
  });

  it("detects a rewritten topicId as tampered", () => {
    const node = signedFull();
    const tampered = { ...node, topicId: "t-OTHER" };
    expect(verifyNode(tampered)).toBe("tampered");
  });

  it("detects a rewritten forkKind as tampered", () => {
    const node = signedFull();
    const tampered = { ...node, forkKind: "alternative" as const };
    expect(verifyNode(tampered)).toBe("tampered");
  });
});

describe("verifyNode never throws on hostile input", () => {
  it("returns a status for random and malformed node-shaped values", () => {
    const kp = generateKeypair();
    const good = textNode(kp.did);
    good.sig = signNode(good, kp.secretKey);

    const garbage: unknown[] = [
      null,
      undefined,
      {},
      { sig: null },
      { sig: {} },
      { sig: { signer: "did:key:zNOPE", canon: "jcs-v1", alg: "ed25519", sig: "@@@@" } },
      { ...good, author: undefined },
      { ...good, sig: { ...good.sig, sig: "not-base64url-%%%" } },
      { ...good, payload: { body: { nested: { deep: Array(50).fill("x") } } } },
    ];
    for (let i = 0; i < 300; i++) {
      const bytes = Array.from({ length: 24 }, () => Math.floor(Math.random() * 256));
      garbage.push({ ...good, sig: { ...good.sig, sig: String.fromCharCode(...bytes) } });
    }

    for (const g of garbage) {
      let out: string | undefined;
      expect(() => {
        out = verifyNode(g as BondNode);
      }).not.toThrow();
      expect(["verified", "unsigned", "tampered"]).toContain(out);
    }
  });
});
