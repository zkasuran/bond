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
}

/** A node narrowed to a single message type, so payload is precisely typed. */
export type TypedNode<K extends MessageType = MessageType> = Omit<
  BondNode,
  "type" | "payload"
> & { type: K; payload: PayloadMap[K] };

/** The discriminated union over every message type. Switch on `.type` to narrow. */
export type AnyNode = { [K in MessageType]: TypedNode<K> }[MessageType];

/** Narrow a node to a specific message type. */
export function isType<K extends MessageType>(
  node: BondNode,
  type: K,
): node is TypedNode<K> {
  return node.type === type;
}
