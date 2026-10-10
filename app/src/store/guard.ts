// The trust gate at the persistence boundary. Verification and dedupe policy live here,
// in one place, so every adapter (memory, sqlite, web) enforces the same rules and they
// cannot drift. verifyNode is the single source of what a signature proves; this module
// turns that into a store/drop decision. See DESIGN.md sec 9.
import type { BondNode } from "../model/node";
import { canonicalNodeDigest, verifyNode } from "../identity/sign";

/** What an adapter does with an incoming node at the append boundary. */
export type IngestOutcome = "store" | "ignore" | "reject";

/** Two nodes carry the same content when their signed canonical bytes match. The signed
 *  subset now covers every structural and semantic field, so this is a full content
 *  compare, not just the id. */
function sameContent(a: BondNode, b: BondNode): boolean {
  const da = canonicalNodeDigest(a);
  const db = canonicalNodeDigest(b);
  if (da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false;
  return true;
}

/** A node whose author is a did:key makes a cryptographic claim about who authored it. A
 *  genuine one is always signed. So an unsigned node that carries a did:key author is a
 *  forgery a relay injected under a victim identity, not a legacy or agent node. Agent and
 *  legacy nodes use non-did:key dids (did:bond:...) and stay valid while unsigned. Binding
 *  attribution to the signature rather than to the free-form author field is the point. */
function claimsSignableIdentity(node: BondNode): boolean {
  const did = node.author?.did;
  return typeof did === "string" && did.startsWith("did:key:");
}

/**
 * Decide whether an incoming node may be written, given whatever is already stored under
 * its id.
 *
 * - A present-but-invalid signature is never stored ("reject"): a tampered node must not
 *   enter the log at all.
 * - An unsigned node that claims a did:key identity is never stored ("reject"): a genuine
 *   did:key node is always signed, so this is impersonation under a victim did.
 * - A fresh id is stored ("store").
 * - A byte-identical re-send is ignored ("ignore"), so the log stays a grow-only union.
 * - A second node that reuses an id with different content cannot shadow the one already
 *   there ("reject"), which closes the forged-duplicate attack. The one exception: a
 *   verified node may displace a stored node that is not verified, so an authentic node
 *   can still reclaim an id a forged placeholder grabbed first.
 */
export function decideIngest(
  existing: BondNode | undefined,
  incoming: BondNode,
): IngestOutcome {
  const incomingStatus = verifyNode(incoming);
  if (incomingStatus === "tampered") return "reject";
  if (incomingStatus === "unsigned" && claimsSignableIdentity(incoming)) return "reject";
  if (!existing) return "store";
  if (sameContent(existing, incoming)) return "ignore";
  if (incomingStatus === "verified" && verifyNode(existing) !== "verified") return "store";
  return "reject";
}

/**
 * Read policy. A tampered node is never returned as part of a room, so a node that was
 * altered at rest cannot be rendered with a stale verified badge. An unsigned node that
 * claims a did:key author is also dropped, since an at-rest edit can inject one the same way
 * a relay can. unsigned agent and legacy nodes (non-did:key dids) are returned; the UI
 * badges them. This gate only drops forgeries, so agent and legacy nodes survive as designed.
 */
export function presentableOnRead(node: BondNode): boolean {
  const status = verifyNode(node);
  if (status === "tampered") return false;
  if (status === "unsigned" && claimsSignableIdentity(node)) return false;
  return true;
}
