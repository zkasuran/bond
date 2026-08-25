import type { AdapterEvent } from "../adapter";
import { GenericOpenAIAdapter } from "../adapters/generic";
import { setFetchImpl } from "../net";

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
});
