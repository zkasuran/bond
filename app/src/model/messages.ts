// Agent-native message payloads. Every node's payload is typed by its MessageType.
// Shapes are pinned to real protocols where one exists (MCP, A2A, SSE streaming) so
// downstream agents can rely on them. See docs/DESIGN.md sec 3.
import type { BondNode, MessageType } from "./node";

/** Prose from a human or agent. Markdown allowed. */
export interface TextPayload {
  body: string;
  /** stable ids of mentioned members, not display strings. */
  mentions?: string[];
}

/** A request to invoke a tool. Mirrors MCP tools/call params, plus a client callId
 *  so a result can be paired even inside a wide fan-out. */
export interface ToolCallPayload {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** MCP content union used inside a tool result. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string; text?: string; blob?: string };
    };

/** Follows the MCP CallToolResult. callId links back to the tool_call. */
export interface ToolResultPayload {
  callId: string;
  content: ContentPart[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Streaming as a native state, not repeated edits. A response opens a streaming
 *  node, deltas append in `seq` order, then done:true closes it. */
export interface TokenDeltaPayload {
  targetId: string;
  seq: number;
  delta: string;
  channel?: "text" | "reasoning" | "tool_args";
  done?: boolean;
}

/** A signed attestation that a set of nodes was produced by an identity and not
 *  altered. The multi-node form of the signing primitive in identity/sign.ts. */
export interface ReceiptPayload {
  subjectIds: string[];
  signer: string;
  alg: "ed25519";
  canonicalization: string;
  digest: string;
  signature: string;
}

/** A machine-authored structured object rendered as a rich card. Grounded in MCP
 *  structuredContent and A2A structured data parts. */
export interface CardPayload {
  variant: string;
  data: Record<string, unknown>;
  schemaRef?: string;
  fallbackText?: string;
}

/** One agent passes a task on with enough context to continue it. Combines A2A task
 *  continuity with the Agent Handoff Protocol package. Also written as a NodeRef of
 *  kind "handoff" at the node where work moved. */
export interface HandoffPayload {
  fromAgent: string;
  toAgent: string;
  objective: string;
  contextId: string;
  referenceTaskIds?: string[];
  conversation: { role: string; content: string }[];
  resources?: { kind: string; uri?: string; data?: unknown }[];
  idempotencyKey: string;
}

export type TaskLifecycle =
  | "submitted"
  | "working"
  | "input_required"
  | "auth_required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export type AgentPresence =
  | "idle"
  | "thinking"
  | "calling_tool"
  | "streaming"
  | "blocked";

/** Agent run state, not just online/typing. Models A2A TaskState. Updated by writing
 *  a new node, never by mutating the tracked one. */
export interface StatusPayload {
  taskId?: string;
  lifecycle?: TaskLifecycle;
  presence?: AgentPresence;
  note?: string;
}

/** An on-chain value transfer recorded in-thread: a tip, a skill purchase, a swap
 *  receipt. Amounts are base units as a string to avoid float loss. */
export interface PaymentPayload {
  cluster: "devnet" | "mainnet-beta" | "testnet";
  /** SPL mint address transferred (e.g. USDC or SKR). */
  mint: string;
  /** Display symbol for the asset, e.g. "USDC". */
  asset: string;
  /** Amount in base units (integer string; divide by 10**decimals for display). */
  amount: string;
  decimals: number;
  /** Solana addresses of the payer and recipient. */
  from: string;
  to: string;
  /** Transaction signature once settled; absent while proposed or pending. */
  signature?: string;
  status: "proposed" | "pending" | "confirmed" | "failed";
  /** What the payment is for, e.g. a tip note or a skill id. */
  memo?: string;
}

/** MessageType -> payload shape. The one place the mapping lives. */
export interface PayloadMap {
  text: TextPayload;
  tool_call: ToolCallPayload;
  tool_result: ToolResultPayload;
  token_delta: TokenDeltaPayload;
  receipt: ReceiptPayload;
  card: CardPayload;
  handoff: HandoffPayload;
  status: StatusPayload;
  payment: PaymentPayload;
}

/** A node narrowed to a single message type, so payload is precisely typed. */
export type TypedNode<K extends MessageType = MessageType> = Omit<
  BondNode,
  "type" | "payload"
> & { type: K; payload: PayloadMap[K] };

/** The discriminated union over every message type. Switch on `.type` to narrow. */
export type AnyNode = { [K in MessageType]: TypedNode<K> }[MessageType];

/** Minimal runtime shape check per MessageType. A node's payload is signed, so a hostile
 *  peer can produce a validly signed node whose payload is null or the wrong shape. The
 *  discriminant alone is therefore not enough to narrow: callers that then read the typed
 *  fields would dereference whatever the attacker put there. This checks the fields a
 *  consumer relies on so a malformed payload is treated as inert, not dereferenced. */
export function isValidPayload(type: MessageType, payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  switch (type) {
    case "text":
      return typeof p.body === "string";
    case "tool_call":
      return typeof p.callId === "string" && typeof p.name === "string";
    case "tool_result":
      return typeof p.callId === "string" && Array.isArray(p.content);
    case "token_delta":
      return (
        typeof p.targetId === "string" &&
        typeof p.seq === "number" &&
        Number.isFinite(p.seq) &&
        typeof p.delta === "string"
      );
    case "receipt":
      return (
        typeof p.signer === "string" &&
        typeof p.digest === "string" &&
        typeof p.signature === "string" &&
        Array.isArray(p.subjectIds)
      );
    case "card":
      return typeof p.variant === "string";
    case "handoff":
      return typeof p.fromAgent === "string" && typeof p.toAgent === "string";
    case "status":
      // Every StatusPayload field is optional, so any object is a valid status.
      return true;
    case "payment":
      return (
        typeof p.mint === "string" &&
        typeof p.amount === "string" &&
        typeof p.from === "string" &&
        typeof p.to === "string"
      );
    default:
      return false;
  }
}

/** Narrow a node to a specific message type. Checks both the discriminant and the payload
 *  shape, so a validly signed node with a mismatched or null payload does not narrow. */
export function isType<K extends MessageType>(
  node: BondNode,
  type: K,
): node is TypedNode<K> {
  return node.type === type && isValidPayload(type, node.payload);
}
