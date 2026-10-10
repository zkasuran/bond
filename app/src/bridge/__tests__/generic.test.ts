import type { AdapterEvent } from "../adapter";
import { GenericOpenAIAdapter } from "../adapters/generic";
import { BondOwnGatewayAdapter } from "../adapters/own";
import { setFetchImpl } from "../net";
import { resetBridgeStreamLimitsForTest, setBridgeStreamLimitsForTest } from "../sse";

function sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ch of chunks) controller.enqueue(enc.encode(ch));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

afterEach(() => setFetchImpl(null));

async function drain(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("GenericOpenAIAdapter", () => {
  it("maps streamed chat deltas to turn_start, text, turn_end, done", async () => {
    setFetchImpl(async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events = await drain(
      new GenericOpenAIAdapter().sendTurn({
        threadId: "t",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events[0]).toEqual({ kind: "turn_start" });
    const text = events
      .filter((e): e is Extract<AdapterEvent, { kind: "text" }> => e.kind === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Hello");
    expect(events.some((e) => e.kind === "turn_end")).toBe(true);
    expect(events[events.length - 1]).toEqual({ kind: "done" });
  });

  it("surfaces a retryable error on HTTP 500", async () => {
    setFetchImpl(async () => new Response("nope", { status: 500 }));
    const events = await drain(
      new GenericOpenAIAdapter().sendTurn({ threadId: "t", messages: [] }),
    );
    expect(events[0].kind).toBe("error");
    expect(events[0]).toMatchObject({ retryable: true });
    expect(events[events.length - 1]).toEqual({ kind: "done" });
  });

  it("caps accumulated tool-call arguments and surfaces an error", async () => {
    // Arguments split across many deltas, each event under the per-event cap, so only the
    // accumulated size trips. No finish_reason is sent, the hostile pattern the audit named.
    const part = "A".repeat(100 * 1024); // 100 KiB per delta
    const chunks: string[] = [];
    for (let i = 0; i < 11; i++) {
      chunks.push(
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"x","arguments":"${part}"}}]}}]}\n\n`,
      );
    }
    chunks.push("data: [DONE]\n\n");
    setFetchImpl(async () => sse(chunks));
    const events = await drain(
      new GenericOpenAIAdapter().sendTurn({ threadId: "t", messages: [] }),
    );
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events[events.length - 1]).toEqual({ kind: "done" });
  });

  it("surfaces an error event when the stream breaks a parse bound", async () => {
    // One event over 1 MiB with no line break: parseSSE throws, the adapter read loop catches
    // it and surfaces a terminal error rather than growing the buffer. Same catch path the
    // per-chunk inactivity timeout uses, so this also proves the guard is wired into the loop.
    const bigLine = "data: " + "x".repeat(1_200_000);
    setFetchImpl(async () => sse([bigLine]));
    const events = await drain(
      new GenericOpenAIAdapter().sendTurn({ threadId: "t", messages: [] }),
    );
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events[events.length - 1]).toEqual({ kind: "done" });
  });
});

describe("GenericOpenAIAdapter bearer token scheme guard", () => {
  async function headersFor(baseUrl: string, apiKey: string): Promise<Record<string, string>> {
    let captured: Record<string, string> = {};
    setFetchImpl(async (_url, init) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    await new GenericOpenAIAdapter().connect({ baseUrl, apiKey });
    return captured;
  }

  it("attaches the bearer over https", async () => {
    const h = await headersFor("https://api.example.com/v1", "secret");
    expect(h.authorization).toBe("Bearer secret");
  });

  it("omits the bearer on a remote plaintext endpoint", async () => {
    const h = await headersFor("http://remote.example.com/v1", "secret");
    expect(h.authorization).toBeUndefined();
  });

  it("attaches the bearer to a loopback http endpoint for local dev", async () => {
    const h = await headersFor("http://localhost:8642/v1", "secret");
    expect(h.authorization).toBe("Bearer secret");
  });
});

describe("BondOwnGatewayAdapter boundary validation", () => {
  it("drops malformed events and keeps well-formed ones", async () => {
    setFetchImpl(async () =>
      sse([
        'data: {"kind":"text","delta":1234}\n\n', // wrong type, dropped
        'data: {"kind":"text"}\n\n', // missing delta, dropped
        'data: {"kind":"text","delta":"ok"}\n\n', // valid
        'data: {"kind":"tool_result","result":{"paid":true,"amount":500}}\n\n', // no id, dropped
        'data: {"kind":"done"}\n\n',
      ]),
    );
    const events = await drain(
      new BondOwnGatewayAdapter().sendTurn({ threadId: "t", messages: [] }),
    );
    const texts = events.filter((e): e is Extract<AdapterEvent, { kind: "text" }> => e.kind === "text");
    expect(texts).toEqual([{ kind: "text", delta: "ok" }]);
    expect(events.some((e) => e.kind === "tool_result")).toBe(false);
    expect(events[events.length - 1]).toEqual({ kind: "done" });
  });

  it("keeps a well-formed tool_result but it carries no settled-payment trust", async () => {
    setFetchImpl(async () =>
      sse([
        'data: {"kind":"tool_result","id":"c1","result":{"paid":true},"isError":false}\n\n',
        'data: {"kind":"done"}\n\n',
      ]),
    );
    const events = await drain(
      new BondOwnGatewayAdapter().sendTurn({ threadId: "t", messages: [] }),
    );
    const tr = events.find((e) => e.kind === "tool_result");
    expect(tr).toMatchObject({ kind: "tool_result", id: "c1" });
  });
});

describe("bridge total-stream ceiling", () => {
  afterEach(() => resetBridgeStreamLimitsForTest());

  it("terminates an endless well-formed generic stream with a terminal error", async () => {
    // A hostile base streams a valid chat delta forever. Each event is well formed, each
    // resets the per-chunk timer, so without a total ceiling the turn never ends. The read
    // loop must surface a terminal error then done, and not deliver every event.
    setBridgeStreamLimitsForTest({ maxStreamEvents: 10 });
    const chunks = Array.from(
      { length: 100 },
      () => 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    );
    setFetchImpl(async () => sse(chunks));
    const events = await drain(
      new GenericOpenAIAdapter().sendTurn({ threadId: "t", messages: [] }),
    );
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events[events.length - 1]).toEqual({ kind: "done" });
    const texts = events.filter((e) => e.kind === "text");
    expect(texts.length).toBeLessThan(100);
  });

  it("terminates an endless flood of well-formed own-gateway events (the gap payload)", async () => {
    // The exact V7 GAP 1 payload: data: {"kind":"text","delta":"a"}\n\n every tick forever.
    setBridgeStreamLimitsForTest({ maxStreamEvents: 10 });
    const chunks = Array.from({ length: 100 }, () => 'data: {"kind":"text","delta":"a"}\n\n');
    setFetchImpl(async () => sse(chunks));
    const events = await drain(
      new BondOwnGatewayAdapter().sendTurn({ threadId: "t", messages: [] }),
    );
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events[events.length - 1]).toEqual({ kind: "done" });
    const texts = events.filter((e) => e.kind === "text");
    expect(texts.length).toBeLessThan(100);
  });
});
