// Bond core node model. The single source of truth for the conversation graph.
// A room is a directed acyclic graph: every node has one structural parent
// (parentId) forming a collapsible spanning tree, plus optional typed cross-edges
// (refs) for fan-in, merge and handoff. Nodes are immutable once written, so the
// local log is a grow-only set and sync is conflict-free. See docs/DESIGN.md sec 2.

/** Discriminant for the payload a node carries. See messages.ts for the shapes. */
export type MessageType =
  | "text"
  | "tool_call"
  | "tool_result"
  | "token_delta"
  | "receipt"
  | "card"
  | "handoff"
  | "status"
  | "payment";

/** Why a branch exists, recorded on the child node that starts it. */
export type ForkKind = "tool_fan" | "subagent" | "alternative" | "reply";

/** Who produced a node. did is a did:key (see identity/keys.ts). */
export interface Identity {
  did: string;
  displayName: string;
  kind: "human" | "agent";
}

/** Ed25519 signature over the canonical bytes of a node. See identity/sign.ts. */
export interface Signature {
  alg: "ed25519";
  /** did:key of the signer. */
  signer: string;
  /** Named, versioned canonicalization recipe so a verifier rebuilds exact bytes. */
  canon: "jcs-v1";
  /** base64url signature over sha256(canonical bytes). */
  sig: string;
}

/** A typed non-tree edge. This is the Matrix "typed relations" lesson, without the
 *  depth limit Matrix forbids. */
export type NodeRefKind =
  | "depends_on"
  | "merges"
  | "handoff"
  | "reply_to"
  | "attests";

export interface NodeRef {
  kind: NodeRefKind;
  /** id of the referenced node. */
  target: string;
}

/**
 * The atomic message unit. Threads, branches, tool-call fans and sub-agent runs are
 * all just regions of the node tree, not separate object kinds.
 */
export interface BondNode<T = unknown> {
  /** ULID: stable, lexicographically sortable, generated client-side. */
  id: string;
  roomId: string;
  /** Optional Zulip-style movable label for human navigation only. */
  topicId?: string;
  /** Structural parent. null only for a room root node. */
  parentId: string | null;
  /** The node this was generated after, when that differs from parentId. */
  causalParent?: string;
  /** Typed non-tree edges that make the room a DAG. */
  refs?: NodeRef[];
  forkKind?: ForkKind;
  /** Lamport logical clock. Total order is (lamport, author.did, id). */
  lamport: number;
  /** ISO 8601. Display only, never used for ordering. */
  createdAt: string;
  author: Identity;
  type: MessageType;
  /** Typed by `type`. See PayloadMap in messages.ts. */
  payload: T;
  /** Sub-agent runs default collapsed in the UI. */
  collapsedByDefault?: boolean;
  /** Present when the node was signed. */
  sig?: Signature;
}

/** The fields covered by a signature. Kept in one place so signer and verifier agree.
 *  identity/sign.ts derives the signed subset from this list, so the two cannot drift.
 *  Order is fixed here but RFC 8785 canonicalization sorts keys, so this is the
 *  membership list, not the byte order.
 *
 *  Structural and semantic fields (refs, causalParent, forkKind, topicId,
 *  collapsedByDefault) are signed too, so a relay cannot rewrite an edge or collapse a
 *  subtree while the node still shows a verified badge. The whole presented author identity
 *  is signed, not just the did: "authorDid" maps to author.did, "authorDisplayName" to
 *  author.displayName and "authorKind" to author.kind (see sign.ts), so a relay cannot keep
 *  a valid did while relabeling the shown name or flipping the human/agent flag. "refs" is
 *  normalized to a sorted {kind,target} set before hashing, so the signature commits to the
 *  set of edges rather than their relay order. */
export const SIGNED_FIELDS = [
  "id",
  "roomId",
  "topicId",
  "parentId",
  "causalParent",
  "refs",
  "forkKind",
  "type",
  "payload",
  "authorDid",
  "authorDisplayName",
  "authorKind",
  "lamport",
  "createdAt",
  "collapsedByDefault",
] as const;

/** A single field name from the signed set. */
export type SignedField = (typeof SIGNED_FIELDS)[number];
