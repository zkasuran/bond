import {
  parseSSE,
  resetBridgeStreamLimitsForTest,
  setBridgeStreamLimitsForTest,
  streamBytes,
} from "../sse";

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

async function collect(chunks: string[], opts?: Record<string, number>) {
  const out = [];
  for await (const e of parseSSE(fromChunks(chunks), opts)) out.push(e);
  return out;
}

describe("parseSSE", () => {
  it("parses events even when split across chunk boundaries", async () => {
    const out = await collect(["data: hel", "lo\n\n", 'event: tool\ndata: {"a":1}\n\n']);
    expect(out).toEqual([{ data: "hello" }, { event: "tool", data: '{"a":1}' }]);
  });

  it("joins multi-line data fields with a newline", async () => {
    const out = await collect(["data: line1\ndata: line2\n\n"]);
    expect(out).toEqual([{ data: "line1\nline2" }]);
  });

  it("ignores comments and handles CRLF, then flushes a trailing event", async () => {
    const out = await collect([": keep-alive\r\n", "data: [DONE]\r\n"]);
    expect(out).toEqual([{ data: "[DONE]" }]);
  });

  it("throws when the unparsed buffer exceeds its cap with no line break", async () => {
    const noNewline = "data: " + "x".repeat(400); // never a newline, so the buffer only grows
    await expect(collect([noNewline], { maxBufferLen: 64 })).rejects.toThrow(/buffer cap/);
  });

  it("throws when one event exceeds its size cap", async () => {
    // many data lines, no terminating blank line, so they accumulate into one event
    const lines = Array.from({ length: 40 }, (_, i) => `data: line-${i}`).join("\n") + "\n";
    await expect(collect([lines], { maxEventLen: 64 })).rejects.toThrow(/size cap/);
  });

  it("throws when one event exceeds its data-line cap", async () => {
    const lines = Array.from({ length: 40 }, () => "data: a").join("\n") + "\n";
    await expect(collect([lines], { maxDataLines: 8 })).rejects.toThrow(/data-line cap/);
  });

  it("throws when the stream exceeds its total event cap", async () => {
    // A hostile endpoint flushes a well-formed event forever. Each one is valid and resets
    // the per-chunk timer, so only a total ceiling ends it. 50 flushed events against a cap
    // of 5 must terminate rather than running unbounded.
    const chunks = Array.from({ length: 50 }, () => "data: a\n\n");
    await expect(collect(chunks, { maxStreamEvents: 5 })).rejects.toThrow(/total event cap/);
  });
});

describe("streamBytes", () => {
  it("aborts a stalled stream with a per-chunk inactivity timeout", async () => {
    // A body that opens, sends nothing, and never closes. Without a timeout reader.read()
    // parks forever. With one, the read loses the race and the stream is torn down.
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const drained = (async () => {
      for await (const _ of streamBytes(body, { inactivityMs: 60 })) {
        // no chunk ever arrives
      }
    })();
    await expect(drained).rejects.toThrow(/stalled/);
  }, 10000);

  it("passes chunks through and does not fire while chunks keep arriving", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode("a"));
        await new Promise((r) => setTimeout(r, 40));
        c.enqueue(enc.encode("b"));
        await new Promise((r) => setTimeout(r, 40));
        c.close();
      },
    });
    const dec = new TextDecoder();
    let text = "";
    for await (const ch of streamBytes(body, { inactivityMs: 500 })) text += dec.decode(ch);
    expect(text).toBe("ab");
  }, 10000);
});

describe("streamBytes total ceilings", () => {
  afterEach(() => resetBridgeStreamLimitsForTest());

  it("throws when total bytes exceed the cap across many chunks", async () => {
    // Each chunk is tiny and arrives at once, so no per-chunk guard trips. Only the running
    // byte total crosses the ceiling.
    setBridgeStreamLimitsForTest({ maxStreamBytes: 100 });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 50; i++) c.enqueue(enc.encode("0123456789")); // 500 bytes total
        c.close();
      },
    });
    const drained = (async () => {
      for await (const _ of streamBytes(body)) {
        // consume
      }
    })();
    await expect(drained).rejects.toThrow(/total byte cap/);
  });

  it("ends an endless but active stream with the total time cap", async () => {
    // A chunk every 20ms, well inside the 60s inactivity window, so the per-chunk timer never
    // fires. Only the total wall-clock ceiling ends it. The pull counter is a safety stop so a
    // missing cap fails by assertion rather than hanging the suite.
    setBridgeStreamLimitsForTest({ maxStreamMs: 100 });
    const enc = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 20));
        if (++pulls > 60) {
          c.close();
          return;
        }
        c.enqueue(enc.encode("a"));
      },
    });
    const drained = (async () => {
      for await (const _ of streamBytes(body)) {
        // consume
      }
    })();
    await expect(drained).rejects.toThrow(/total time cap/);
  }, 10000);
});
