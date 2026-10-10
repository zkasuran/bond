// Hermes adapter. Targets the Hermes (Nous Research) OpenAI-compatible API server's run
// API: POST {base}/runs returns a run id, then GET {base}/runs/{id}/events streams SSE
// lifecycle and tool events. Bearer auth. On React Native the browser EventSource is
// absent, so this uses the streaming fetch + SSE reader.
//
// The exact SSE envelope (event names, field names) is taken from the Hermes api_server
// source cited in docs/DESIGN.md and is parsed defensively: the SSE `event:` line is the
// type, with a fallback to a type/event field inside the JSON. Confirm against a live
// server before treating field names as frozen.
import type {
  AdapterEvent,
  GatewayAdapter,
  GatewayCapabilities,
  GatewayConfig,
  SendTurnInput,
} from "../adapter";
import { allowBearer, getStreamingFetch, joinUrl } from "../net";
import { BridgeStreamError, parseSSE, streamBytes } from "../sse";

function tryJSON(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export class HermesAdapter implements GatewayAdapter {
  readonly id = "hermes";
  readonly displayName = "Hermes";
  private config: GatewayConfig = { baseUrl: "http://localhost:8642/v1" };

  private headers(): Record<string, string> {
    const key = this.config.apiKey;
    return {
      "content-type": "application/json",
      accept: "text/event-stream",
      // Only send the bearer over TLS or to a loopback host, never a remote plaintext endpoint.
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
      throw new Error(`Hermes connect failed: ${res.status} ${res.statusText}`.trim());
    }
    return {
      streaming: true,
      tools: "native",
      sessions: true,
      threading: true,
      multiAgent: false,
      identity: config.apiKey ? "token" : "none",
      transports: ["openai-http", "custom"],
    };
  }

  async *sendTurn(input: SendTurnInput): AsyncIterable<AdapterEvent> {
    let runId: string | undefined;
    try {
      const runRes = await getStreamingFetch()(joinUrl(this.config.baseUrl, "runs"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.model,
          messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
          session_key: input.sessionKey,
        }),
        signal: input.signal,
      });
      if (!runRes.ok) {
        yield { kind: "error", message: `Hermes run failed: HTTP ${runRes.status}`, retryable: runRes.status >= 500 };
        yield { kind: "done" };
        return;
      }
      const run = await runRes.json();
      runId = run?.run_id ?? run?.id;
    } catch (e) {
      yield { kind: "error", message: String((e as Error)?.message ?? e), retryable: true };
      yield { kind: "done" };
      return;
    }

    yield { kind: "turn_start", runId };

    const evRes = await getStreamingFetch()(
      joinUrl(this.config.baseUrl, `runs/${runId}/events`),
      { method: "GET", headers: this.headers(), signal: input.signal },
    );
    if (!evRes.ok || !evRes.body) {
      yield { kind: "error", message: `Hermes events failed: HTTP ${evRes.status}`, retryable: true };
      yield { kind: "turn_end", runId };
      yield { kind: "done" };
      return;
    }

    try {
      for await (const ev of parseSSE(streamBytes(evRes.body))) {
        if (ev.data === "[DONE]") break;
        const data = tryJSON(ev.data) ?? {};
        const type = ev.event ?? data.type ?? data.event;
        switch (type) {
          case "run.started":
            break;
          case "assistant.delta":
          case "message.delta": {
            const delta = data.delta ?? data.content ?? "";
            if (delta) yield { kind: "text", delta: String(delta) };
            break;
          }
          case "tool.started":
            yield {
              kind: "tool_call",
              id: data.id ?? data.tool_call_id ?? "",
              name: data.name ?? "",
              args: data.arguments ?? data.args ?? {},
            };
            break;
          case "tool.completed":
          case "tool.failed":
            yield {
              kind: "tool_result",
              id: data.id ?? data.tool_call_id ?? "",
              result: data.result ?? data.output ?? null,
              isError: type === "tool.failed",
            };
            break;
          case "run.completed":
            yield { kind: "turn_end", runId };
            break;
          case "run.failed":
          case "error":
            yield { kind: "error", message: data.message ?? "Hermes run error", retryable: false };
            break;
          default:
            break;
        }
      }
    } catch (e) {
      const retryable = e instanceof BridgeStreamError ? e.retryable : true;
      yield { kind: "error", message: String((e as Error)?.message ?? e), retryable };
      yield { kind: "done" };
      return;
    }
    yield { kind: "done" };
  }

  async disconnect(): Promise<void> {}
}
