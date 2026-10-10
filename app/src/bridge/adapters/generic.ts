// Generic OpenAI-compatible adapter. Any runtime exposing an OpenAI-style base URL is
// supported: connect probes GET {baseUrl}/models, sendTurn POSTs {baseUrl}/chat/completions
// with stream:true and maps the SSE deltas to Bond's normalized AdapterEvent stream.
// This is the proof the contract generalizes. See DESIGN.md sec 4.
import type {
  AdapterEvent,
  ChatMessage,
  GatewayAdapter,
  GatewayCapabilities,
  GatewayConfig,
  SendTurnInput,
} from "../adapter";
import { allowBearer, getStreamingFetch, joinUrl } from "../net";
import { BridgeStreamError, bridgeStreamLimits, parseSSE, streamBytes } from "../sse";

interface ToolAcc {
  id?: string;
  name?: string;
  args: string;
}

export class GenericOpenAIAdapter implements GatewayAdapter {
  readonly id: string = "generic";
  readonly displayName: string = "OpenAI-compatible";
  protected config: GatewayConfig = { baseUrl: "" };

  protected headers(): Record<string, string> {
    const key = this.config.apiKey;
    return {
      "content-type": "application/json",
      accept: "text/event-stream",
      // Only send the bearer over TLS or to a loopback host, never to a remote plaintext
      // endpoint where an on-path observer could read it.
      ...(key && allowBearer(this.config.baseUrl) ? { authorization: `Bearer ${key}` } : {}),
      ...(this.config.headers ?? {}),
    };
  }

  async connect(config: GatewayConfig): Promise<GatewayCapabilities> {
    this.config = config;
    const res = await getStreamingFetch()(joinUrl(config.baseUrl, "models"), {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`connect failed: ${res.status} ${res.statusText}`.trim());
    }
    return this.capabilities();
  }

  protected capabilities(): GatewayCapabilities {
    return {
      streaming: true,
      tools: "native",
      sessions: false,
      threading: false,
      multiAgent: false,
      identity: this.config.apiKey ? "token" : "none",
      transports: ["openai-http"],
    };
  }

  protected buildBody(input: SendTurnInput): Record<string, unknown> {
    return {
      model: this.config.model ?? "gpt-4o-mini",
      stream: true,
      messages: input.messages.map((m) => this.toWire(m)),
    };
  }

  protected toWire(m: ChatMessage): Record<string, unknown> {
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.name) out.name = m.name;
    if (m.toolCallId) out.tool_call_id = m.toolCallId;
    return out;
  }

  async *sendTurn(input: SendTurnInput): AsyncIterable<AdapterEvent> {
    const url = joinUrl(this.config.baseUrl, "chat/completions");
    let res: Response;
    try {
      res = await getStreamingFetch()(url, {
        method: "POST",
        headers: this.sessionHeaders(input),
        body: JSON.stringify(this.buildBody(input)),
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

    const lim = bridgeStreamLimits();
    let started = false;
    const tools = new Map<number, ToolAcc>();
    try {
      for await (const ev of parseSSE(streamBytes(res.body))) {
        if (ev.data === "[DONE]") break;
        let json: any;
        try {
          json = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const choice = json?.choices?.[0];
        if (!choice) continue;
        if (!started) {
          started = true;
          yield { kind: "turn_start" };
        }
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { kind: "text", delta: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i: number = tc.index ?? 0;
            if (!tools.has(i) && tools.size >= lim.maxToolCalls) {
              throw new BridgeStreamError("agent stream exceeded its tool-call count cap");
            }
            const cur = tools.get(i) ?? { args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) {
              cur.args += tc.function.arguments;
              if (cur.args.length > lim.maxToolArgsLen) {
                throw new BridgeStreamError("agent stream tool-call arguments exceeded their size cap");
              }
            }
            tools.set(i, cur);
          }
        }
        if (choice.finish_reason) {
          for (const tc of tools.values()) {
            let args: unknown = {};
            try {
              args = tc.args ? JSON.parse(tc.args) : {};
            } catch {
              args = tc.args;
            }
            yield { kind: "tool_call", id: tc.id ?? `call_${tools.size}`, name: tc.name ?? "", args };
          }
          tools.clear();
        }
      }
    } catch (e) {
      const retryable = e instanceof BridgeStreamError ? e.retryable : true;
      yield { kind: "error", message: String((e as Error)?.message ?? e), retryable };
      yield { kind: "done" };
      return;
    }
    if (!started) yield { kind: "turn_start" };
    yield { kind: "turn_end" };
    yield { kind: "done" };
  }

  protected sessionHeaders(input: SendTurnInput): Record<string, string> {
    const h = this.headers();
    if (this.config.sessionHeader && input.sessionKey) {
      h[this.config.sessionHeader] = input.sessionKey;
    }
    return h;
  }

  async disconnect(): Promise<void> {
    // stateless HTTP, nothing to tear down
  }
}
