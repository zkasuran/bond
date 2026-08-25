import { generateKeypair, publicKeyToDid, didToPublicKey } from "../keys";
import { signNode, verifyNode } from "../sign";
import { makeNode } from "../../model/factory";
import type { Identity } from "../../model/node";

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
