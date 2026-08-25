// Server-Sent-Events parsing, kept pure so it unit-tests against a mock stream. React
// Native's built-in fetch does not stream response bodies, so adapters obtain a real
// streaming Response from expo/fetch (see bridge/net.ts) and hand its body here.

export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
}

/** Turn a ReadableStream of bytes into an async iterable of chunks. */
export async function* streamBytes(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an SSE byte/text stream into events. Handles multi-line data fields and CRLF,
 * and flushes a trailing event with no terminating blank line. Comments (lines
 * starting with ":") are ignored.
 */
export async function* parseSSE(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  const flush = (): SSEEvent | null => {
    if (dataLines.length === 0 && event === undefined && id === undefined) return null;
    const out: SSEEvent = { data: dataLines.join("\n") };
    if (event !== undefined) out.event = event;
    if (id !== undefined) out.id = id;
    event = undefined;
    id = undefined;
    dataLines.length = 0;
    return out;
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        const ev = flush();
        if (ev) yield ev;
        continue;
      }
      if (line.startsWith(":")) continue; // comment

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "data") dataLines.push(value);
      else if (field === "event") event = value;
      else if (field === "id") id = value;
      // "retry" and unknown fields are ignored
    }
  }
  const ev = flush();
  if (ev) yield ev;
}
