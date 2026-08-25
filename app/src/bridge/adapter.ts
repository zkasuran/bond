// The universal agent-bridge contract. Every runtime, existing or future, is normalized
// to one GatewayAdapter emitting one AdapterEvent stream. Runtime-specific transport
// (OpenClaw pairing, Hermes bearer auth, a raw WebSocket dialect) hides behind the
// adapter and never leaks into Bond's room and threading core. See DESIGN.md sec 4.

export interface GatewayCapabilities {
  streaming: boolean;
  tools: "mcp" | "native" | "none";
  /** server keeps per-thread history. */
  sessions: boolean;
  threading: boolean;
  /** more than one addressable agent target. */
  multiAgent: boolean;
  identity: "signed" | "token" | "none";
  transports: ("openai-http" | "mcp" | "websocket" | "custom")[];
}

/** A chat message in the shape adapters send upstream (OpenAI-compatible). */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolResult {
  content: unknown;
  isError?: boolean;
}

/** Connection config for an adapter. Adapter-specific extras ride in `extra`. */
export interface GatewayConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  /** header name used to pin a Bond thread to an upstream session, if the runtime supports it. */
  sessionHeader?: string;
  extra?: Record<string, unknown>;
}

/** The single normalized event stream Bond's core consumes. */
export type AdapterEvent =
  | { kind: "turn_start"; runId?: string; agentId?: string }
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; id: string; name: string; args: unknown }
  | { kind: "tool_result"; id: string; result: unknown; isError?: boolean }
  | { kind: "turn_end"; runId?: string }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "done" };

export interface SendTurnInput {
  threadId: string;
  /** maps a Bond thread to one upstream session so history stays coherent. */
  sessionKey?: string;
  messages: ChatMessage[];
  /** which addressable agent to route to, when the runtime has more than one. */
  agentTarget?: string;
  signal?: AbortSignal;
}

export interface GatewayAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Live probe: verify reachability and auth, return what the runtime can actually do. */
  connect(config: GatewayConfig): Promise<GatewayCapabilities>;
  /** One exchange. Must emit turn_end per assistant turn and a single terminal done. */
  sendTurn(input: SendTurnInput): AsyncIterable<AdapterEvent>;
  listTools?(): Promise<ToolSpec[]>;
  callTool?(name: string, args: unknown): Promise<ToolResult>;
  history?(sessionKey: string, opts?: { limit?: number }): Promise<ChatMessage[]>;
  disconnect(): Promise<void>;
}

/** Identifiers for the adapters Bond ships. Used by the connect UI and the registry. */
export type AdapterKind = "bond" | "generic" | "hermes" | "openclaw";
