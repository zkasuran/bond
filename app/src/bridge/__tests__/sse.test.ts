import { parseSSE } from "../sse";

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const e of parseSSE(fromChunks(chunks))) out.push(e);
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
});
