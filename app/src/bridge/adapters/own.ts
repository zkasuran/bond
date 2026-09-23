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
import { parseSSE, streamBytes } from "../sse";
import { GenericOpenAIAdapter } from "./generic";

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

    for await (const ev of parseSSE(streamBytes(res.body))) {
      if (!ev.data) continue;
      let parsed: AdapterEvent;
      try {
        parsed = JSON.parse(ev.data) as AdapterEvent;
      } catch {
        continue;
      }
      yield parsed;
      if (parsed.kind === "done") return;
    }
    yield { kind: "done" };
  }
}
