// Node canonicalization, signing and offline verification. The "jcs-v1" recipe:
// RFC 8785 JSON Canonicalization over a fixed field subset, UTF-8 encoded, SHA-256
// hashed, then Ed25519 signed. A verifier rebuilds the exact bytes with no private
// key in the loop. See DESIGN.md sec 5.
import { jcs } from "./jcs";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import type { BondNode, Signature } from "../model/node";
import { didToPublicKey, signBytes, verifyBytes } from "./keys";

const utf8 = new TextEncoder();

/** The digest signed for a node. The signed subset is fixed and versioned by `canon`. */
export function canonicalNodeDigest(node: BondNode): Uint8Array {
  const subset = {
    id: node.id,
    roomId: node.roomId,
    parentId: node.parentId,
    type: node.type,
    payload: node.payload,
    authorDid: node.author.did,
    lamport: node.lamport,
    createdAt: node.createdAt,
  };
  return sha256(utf8.encode(jcs(subset)));
}

/** Produce a Signature for a node. The node's author.did must be the signer. */
export function signNode(node: BondNode, secretKey: Uint8Array): Signature {
  const digest = canonicalNodeDigest(node);
  const sig = signBytes(digest, secretKey);
  return {
    alg: "ed25519",
    signer: node.author.did,
    canon: "jcs-v1",
    sig: base64urlnopad.encode(sig),
  };
}

export type VerifyResult = "verified" | "unsigned" | "tampered";

/**
 * Offline verification. "unsigned" is the honest default for a node Bond did not sign.
 * "tampered" means a signature is present but does not check out, including the case
 * where the signer did does not match the claimed author.
 */
export function verifyNode(node: BondNode): VerifyResult {
  if (!node.sig) return "unsigned";
  try {
    if (node.sig.signer !== node.author.did) return "tampered";
    const pub = didToPublicKey(node.sig.signer);
    const digest = canonicalNodeDigest(node);
    const sig = base64urlnopad.decode(node.sig.sig);
    return verifyBytes(sig, digest, pub) ? "verified" : "tampered";
  } catch {
    return "tampered";
  }
}
