// Bond's own gateway adapter. Targets Bond's backend (server/), which runs the AI agent
// runtime: a tool-calling loop over Anthropic or OpenAI with on-chain Solana tools and
// MCP skills, exposed at POST /v1/agent/turn as a normalized AdapterEvent SSE stream. The
// gateway and the exact model are never named in tracked code, the store listing, the
// video or the app. See DESIGN.md sec 4.
import type {
  AdapterEvent,
  GatewayCapabilities,
  SendTurnInput,
} from "../adapter";
import { getStreamingFetch, joinUrl } from "../net";
import { BridgeStreamError, bridgeStreamLimits, parseSSE, streamBytes } from "../sse";
import { GenericOpenAIAdapter } from "./generic";

const EVENT_KINDS = new Set([
  "turn_start",
  "text",
  "tool_call",
  "tool_result",
  "turn_end",
  "error",
  "done",
]);

const isString = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";
const optBool = (v: unknown): boolean => v === undefined || typeof v === "boolean";

/** True when a value serializes to at most `cap` characters. A circular or unserializable
 *  value fails closed. */
function withinSize(v: unknown, cap: number): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.length <= cap;
  try {
    return JSON.stringify(v).length <= cap;
  } catch {
    return false;
  }
}

// Validate a parsed server event at the trust boundary before it enters Bond's core. The
// gateway is ours but the bytes on the wire are untrusted, so the full AdapterEvent shape is
// checked per kind: required fields, their types, and a size cap on any payload. A null, a
// non-object, an unknown kind, a wrong-typed or oversized field is dropped rather than
// yielded, which would otherwise feed a consumer that switches on `ev.kind` a malformed or
// memory-exhausting event. A `tool_result` that passes here is still only agent-reported: the
// bridge cannot settle a payment, so the on-chain signature check in the model/render layer is
// what makes it authentic, and this adapter never treats it as a settled fact.
function isAdapterEvent(value: unknown): value is AdapterEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind)) return false;
  const cap = bridgeStreamLimits().maxEventDataLen;
  switch (kind) {
    case "turn_start":
      return optStr(v.runId) && optStr(v.agentId);
    case "text":
      return isString(v.delta) && v.delta.length <= cap;
    case "tool_call":
      return isString(v.id) && isString(v.name) && "args" in v && withinSize(v.args, cap);
    case "tool_result":
      return isString(v.id) && "result" in v && optBool(v.isError) && withinSize(v.result, cap);
    case "turn_end":
      return optStr(v.runId);
    case "error":
      return isString(v.message) && typeof v.retryable === "boolean";
    case "done":
      return true;
    default:
      return false;
  }
}

export class BondOwnGatewayAdapter extends GenericOpenAIAdapter {
  readonly id = "bond";
  readonly displayName = "Bond gateway";

  protected capabilities(): GatewayCapabilities {
    return {
      streaming: true,
      tools: "mcp",
      sessions: true,
      threading: true,
      multiAgent: true,
      identity: "token",
      transports: ["openai-http", "mcp"],
    };
  }

  // The Bond agent runtime already speaks the AdapterEvent shape over SSE, so unlike the
  // generic adapter there is no OpenAI translation: parse each event and yield it as-is.
  async *sendTurn(input: SendTurnInput): AsyncIterable<AdapterEvent> {
    const url = joinUrl(this.config.baseUrl, "agent/turn");
    const system = input.messages.find((m) => m.role === "system")?.content;
    const messages = input.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = { messages, runId: input.threadId };
    if (system) body.system = system;
    if (this.config.model) body.model = this.config.model;
    if (input.skills?.length) body.skills = input.skills;

    let res: Response;
    try {
      res = await getStreamingFetch()(url, {
        method: "POST",
        headers: this.sessionHeaders(input),
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (e) {
      yield { kind: "error", message: String((e as Error)?.message ?? e), retryable: true };
      yield { kind: "done" };
      return;
    }
    if (!res.ok || !res.body) {
      yield {
        kind: "error",
        message: `HTTP ${res.status} ${res.statusText}`.trim(),
        retryable: res.status >= 500 || res.status === 429,
      };
      yield { kind: "done" };
      return;
    }

    try {
      for await (const ev of parseSSE(streamBytes(res.body))) {
        if (!ev.data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (!isAdapterEvent(parsed)) continue; // drop anything that is not a well-formed event
        yield parsed;
        if (parsed.kind === "done") return;
      }
    } catch (e) {
      const retryable = e instanceof BridgeStreamError ? e.retryable : true;
      yield { kind: "error", message: String((e as Error)?.message ?? e), retryable };
      yield { kind: "done" };
      return;
    }
    yield { kind: "done" };
  }
}
