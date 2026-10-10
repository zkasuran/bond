// Node canonicalization, signing and offline verification. The "jcs-v1" recipe:
// RFC 8785 JSON Canonicalization over a fixed field subset, UTF-8 encoded, SHA-256
// hashed, then Ed25519 signed. A verifier rebuilds the exact bytes with no private
// key in the loop. See DESIGN.md sec 5.
import { jcs } from "./jcs";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import type { BondNode, NodeRef, Signature, SignedField } from "../model/node";
import { SIGNED_FIELDS } from "../model/node";
import { didToPublicKey, signBytes, verifyBytes } from "./keys";

const utf8 = new TextEncoder();

/** Normalize refs to a sorted set of the two fields a signature commits to. Sorting by
 *  (kind, target) makes the signed bytes independent of the order a relay sends edges in,
 *  so reordering is a no-op but adding, dropping or rewriting an edge is detected. Extra
 *  fields a hostile relay smuggles onto a ref are dropped before hashing. */
function canonicalRefs(refs: NodeRef[] | undefined): { kind: string; target: string }[] | undefined {
  if (!refs) return undefined;
  return refs
    .map((r) => ({ kind: r.kind, target: r.target }))
    .sort((a, b) =>
      a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
    );
}

/** The value a signed field contributes. Most map straight through; the author fields are
 *  pulled from the author object and refs is canonicalized. Signing the display name and the
 *  kind, not just the did, stops a relay relabeling a verified node or flipping its
 *  human/agent flag while the signature still checks out. */
function signedValue(node: BondNode, field: SignedField): unknown {
  if (field === "authorDid") return node.author?.did;
  if (field === "authorDisplayName") return node.author?.displayName;
  if (field === "authorKind") return node.author?.kind;
  if (field === "refs") return canonicalRefs(node.refs);
  return (node as unknown as Record<string, unknown>)[field];
}

/** The exact object that gets canonicalized and hashed. Built from SIGNED_FIELDS so the
 *  signer and the verifier use one list. Exposed so a test can assert the signed key set.
 *  jcs drops undefined-valued keys, so an absent optional field never changes the bytes. */
export function canonicalSubset(node: BondNode): Record<string, unknown> {
  const subset: Record<string, unknown> = {};
  for (const field of SIGNED_FIELDS) subset[field] = signedValue(node, field);
  return subset;
}

/** The digest signed for a node. The signed subset is fixed and versioned by `canon`. */
export function canonicalNodeDigest(node: BondNode): Uint8Array {
  return sha256(utf8.encode(jcs(canonicalSubset(node))));
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
 * where the signer did does not match the claimed author. Hostile or malformed input
 * never throws: anything that is not a clean, verifiable signature returns a status.
 */
export function verifyNode(node: BondNode): VerifyResult {
  if (!node || typeof node !== "object") return "unsigned";
  if (!node.sig) return "unsigned";
  try {
    if (node.sig.signer !== node.author?.did) return "tampered";
    const pub = didToPublicKey(node.sig.signer);
    const digest = canonicalNodeDigest(node);
    const sig = base64urlnopad.decode(node.sig.sig);
    return verifyBytes(sig, digest, pub) ? "verified" : "tampered";
  } catch {
    return "tampered";
  }
}
