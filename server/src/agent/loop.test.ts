import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { partToEvent, streamAgent } from "./loop.js";
import { sseFor, type AdapterEvent } from "./events.js";

// A finish part the mock model needs to close each step.
function finish(reason: string) {
  return {
    type: "finish",
    finishReason: reason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

async function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("partToEvent maps each stream part kind", () => {
  assert.deepEqual(partToEvent({ type: "text-delta", id: "1", text: "hi" } as never), {
    kind: "text",
    delta: "hi",
  });
  assert.equal(partToEvent({ type: "text-delta", id: "1", text: "" } as never), null);
  assert.deepEqual(
    partToEvent({ type: "tool-call", toolCallId: "c1", toolName: "t", input: { a: 1 } } as never),
    { kind: "tool_call", id: "c1", name: "t", args: { a: 1 } },
  );
  assert.deepEqual(
    partToEvent({ type: "tool-result", toolCallId: "c1", toolName: "t", output: { ok: true } } as never),
    { kind: "tool_result", id: "c1", result: { ok: true } },
  );
  assert.deepEqual(
    partToEvent({ type: "tool-error", toolCallId: "c1", toolName: "t", error: new Error("boom") } as never),
    { kind: "tool_result", id: "c1", result: "boom", isError: true },
  );
  assert.deepEqual(partToEvent({ type: "error", error: new Error("nope") } as never), {
    kind: "error",
    message: "nope",
    retryable: false,
  });
  // Lifecycle parts the app does not need are dropped.
  assert.equal(partToEvent({ type: "start-step" } as never), null);
  assert.equal(partToEvent({ type: "finish" } as never), null);
});

test("sseFor emits one framed SSE message with event name and JSON body", () => {
  const frame = sseFor({ kind: "text", delta: "hi" });
  assert.equal(frame, 'event: text\ndata: {"kind":"text","delta":"hi"}\n\n');
});

test("streamAgent streams text with a clean turn_start / turn_end / done lifecycle", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "Hello" },
        { type: "text-delta", id: "1", delta: " world" },
        { type: "text-end", id: "1" },
        finish("stop"),
      ] as never),
    }),
  });

  const events = await collect(
    streamAgent({ model, tools: {}, messages: [{ role: "user", content: "hi" }], runId: "r1" }),
  );

  assert.deepEqual(events[0], { kind: "turn_start", runId: "r1" });
  assert.deepEqual(events.at(-2), { kind: "turn_end", runId: "r1" });
  assert.deepEqual(events.at(-1), { kind: "done" });
  const text = events
    .filter((e): e is Extract<AdapterEvent, { kind: "text" }> => e.kind === "text")
    .map((e) => e.delta)
    .join("");
  assert.equal(text, "Hello world");
});

test("streamAgent surfaces a tool call from the model as a tool_call event", async () => {
  // Note: this asserts the tool_call is surfaced and normalised. Actual tool
  // execution and the follow-up step are covered against a real provider in the
  // live smoke plus against the tool layer directly in tools.test.ts, because
  // MockLanguageModelV4 does not run tool execute for a synthesised call.
  const echo = tool({
    description: "echo the value back",
    inputSchema: z.object({ value: z.string() }),
    execute: async ({ value }) => ({ echoed: value }),
  });
  const tools: ToolSet = { echo };

  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "call1", toolName: "echo" },
        { type: "tool-input-delta", id: "call1", delta: JSON.stringify({ value: "abc" }) },
        { type: "tool-input-end", id: "call1" },
        { type: "tool-call", toolCallId: "call1", toolName: "echo", input: JSON.stringify({ value: "abc" }) },
        finish("tool-calls"),
      ] as never),
    }),
  });

  const events = await collect(
    streamAgent({ model, tools, messages: [{ role: "user", content: "go" }], maxSteps: 4 }),
  );

  const call = events.find((e) => e.kind === "tool_call");
  assert.ok(call && call.kind === "tool_call", "a tool_call event should be emitted");
  assert.equal(call.name, "echo");
  assert.deepEqual(call.args, { value: "abc" });
  assert.equal(events[0].kind, "turn_start");
  assert.equal(events.at(-1)?.kind, "done");
});
