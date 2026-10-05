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

/**
 * Decide whether an incoming node may be written, given whatever is already stored under
 * its id.
 *
 * - A present-but-invalid signature is never stored ("reject"): a tampered node must not
 *   enter the log at all.
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
  if (!existing) return "store";
  if (sameContent(existing, incoming)) return "ignore";
  if (incomingStatus === "verified" && verifyNode(existing) !== "verified") return "store";
  return "reject";
}

/**
 * Read policy. A tampered node is never returned as part of a room, so a node that was
 * altered at rest cannot be rendered with a stale verified badge. unsigned and verified
 * nodes are both returned; the UI badges them. This gate only drops forgeries, so agent
 * and legacy (unsigned) nodes survive as designed.
 */
export function presentableOnRead(node: BondNode): boolean {
  return verifyNode(node) !== "tampered";
}
