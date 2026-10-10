// Server-Sent-Events parsing, kept pure so it unit-tests against a mock stream. React
// Native's built-in fetch does not stream response bodies, so adapters obtain a real
// streaming Response from expo/fetch (see bridge/net.ts) and hand its body here.
//
// The bytes on the wire are untrusted (the generic, hermes and openclaw adapters connect
// to an arbitrary endpoint, so a compromised or MITM server is in scope). Reading them is
// therefore bounded: a hard cap on the unparsed buffer, on a single assembled event, on the
// data-line count, a per-chunk inactivity timeout and a total ceiling on the whole stream
// (wall-clock, total bytes and total event count). A stream that breaks any ceiling, goes
// silent or stays well-formed but never ends is torn down and surfaced as an error rather
// than running forever or growing the consumer without bound.

export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
}

/** A fatal stream condition: a cap was exceeded or the stream stalled. Adapters catch this
 *  and surface it as a terminal `error` event instead of letting it crash the consumer. */
export class BridgeStreamError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.name = "BridgeStreamError";
    this.retryable = retryable;
  }
}

/** Every ceiling on untrusted bridge ingest, in one place (lengths are JS string units). */
export interface BridgeStreamLimits {
  /** abort when no chunk arrives within this many ms. */
  inactivityMs: number;
  /** cap on the unparsed SSE buffer, i.e. a line with no newline. */
  maxBufferLen: number;
  /** cap on one assembled event's accumulated data. */
  maxEventLen: number;
  /** cap on data lines in one event before a blank-line flush. */
  maxDataLines: number;
  /** cap on accumulated tool-call arguments (generic adapter). */
  maxToolArgsLen: number;
  /** cap on distinct tool-call indices in one turn (generic adapter). */
  maxToolCalls: number;
  /** cap on a single validated event payload (own adapter: a text delta or a tool result). */
  maxEventDataLen: number;
  /** total wall-clock for one stream, so a well-formed stream that never idles still ends. */
  maxStreamMs: number;
  /** cap on total bytes read across the whole stream, independent of per-event framing. */
  maxStreamBytes: number;
  /** cap on total events parsed across the whole stream, so an endless flush loop ends and
   *  the downstream consumer cannot grow without bound. */
  maxStreamEvents: number;
}

const DEFAULTS: BridgeStreamLimits = Object.freeze({
  inactivityMs: 60_000,
  maxBufferLen: 1 << 20, // 1 MiB
  maxEventLen: 1 << 20, // 1 MiB
  maxDataLines: 10_000,
  maxToolArgsLen: 1 << 20, // 1 MiB
  maxToolCalls: 256,
  maxEventDataLen: 256 * 1024, // 256 KiB
  maxStreamMs: 600_000, // 10 min total: generous for one turn, finite so a forever-stream ends
  maxStreamBytes: 64 << 20, // 64 MiB total across the whole stream
  maxStreamEvents: 200_000, // total SSE events in one turn
});

let active: BridgeStreamLimits = { ...DEFAULTS };

/** The limits in force now. */
export function bridgeStreamLimits(): BridgeStreamLimits {
  return active;
}

/** Shrink one or more limits so a test can trip a ceiling cheaply. Pair with the reset. */
export function setBridgeStreamLimitsForTest(partial: Partial<BridgeStreamLimits>): void {
  active = { ...active, ...partial };
}

/** Restore the shipped limits. Call in an afterEach so overrides do not leak. */
export function resetBridgeStreamLimitsForTest(): void {
  active = { ...DEFAULTS };
}

/**
 * Turn a ReadableStream of bytes into an async iterable of chunks, with a per-chunk
 * inactivity timeout and a total ceiling on the whole stream. Each `reader.read()` races a
 * single timer, recreated every chunk, that is armed for whichever ceiling is nearer: the
 * per-chunk inactivity window or what is left of the total wall-clock budget. On either the
 * reader is cancelled (that tears the underlying request down) and a BridgeStreamError is
 * thrown. A running byte total is also checked after each chunk. The branch (stall vs total
 * cap) is decided when the timer is armed, not by a later Date.now() re-check, so a
 * well-formed stream that never idles still ends on the total cap rather than being misread
 * as a stall. The finally cancels the reader on any exit, so a stalled, over-budget or
 * abandoned stream never leaks a socket.
 */
export async function* streamBytes(
  body: ReadableStream<Uint8Array>,
  opts: { inactivityMs?: number } = {},
): AsyncGenerator<Uint8Array> {
  const inactivityMs = opts.inactivityMs ?? active.inactivityMs;
  const maxStreamMs = active.maxStreamMs;
  const maxStreamBytes = active.maxStreamBytes;
  const hardDeadline = Date.now() + maxStreamMs;
  const reader = body.getReader();
  let totalBytes = 0;
  try {
    for (;;) {
      const remaining = hardDeadline - Date.now();
      if (remaining <= 0) {
        throw new BridgeStreamError(`agent stream exceeded its total time cap of ${maxStreamMs}ms`, false);
      }
      const deadlineBound = remaining <= inactivityMs;
      const waitMs = deadlineBound ? remaining : inactivityMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limitHit = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              deadlineBound
                ? new BridgeStreamError(`agent stream exceeded its total time cap of ${maxStreamMs}ms`, false)
                : new BridgeStreamError(`agent stream stalled: no data for ${inactivityMs}ms`),
            ),
          waitMs,
        );
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), limitHit]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (chunk.done) break;
      if (chunk.value) {
        totalBytes += chunk.value.byteLength;
        if (totalBytes > maxStreamBytes) {
          throw new BridgeStreamError(`agent stream exceeded its total byte cap of ${maxStreamBytes} bytes`, false);
        }
        yield chunk.value;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Parse an SSE byte/text stream into events. Handles multi-line data fields and CRLF,
 * and flushes a trailing event with no terminating blank line. Comments (lines
 * starting with ":") are ignored. Bounded: throws a BridgeStreamError if the unparsed
 * buffer, one event's data, the data-line count or the total number of events across the
 * stream exceeds its cap, so a newline-free, never-flushed or endless well-formed stream
 * cannot exhaust memory or run the turn forever.
 */
export async function* parseSSE(
  chunks: AsyncIterable<Uint8Array | string>,
  opts: Partial<BridgeStreamLimits> = {},
): AsyncGenerator<SSEEvent> {
  const lim = { ...active, ...opts };
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];
  let eventLen = 0;
  let eventCount = 0;

  const flush = (): SSEEvent | null => {
    if (dataLines.length === 0 && event === undefined && id === undefined) return null;
    const out: SSEEvent = { data: dataLines.join("\n") };
    if (event !== undefined) out.event = event;
    if (id !== undefined) out.id = id;
    event = undefined;
    id = undefined;
    dataLines.length = 0;
    eventLen = 0;
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
        if (ev) {
          if (++eventCount > lim.maxStreamEvents) {
            throw new BridgeStreamError(`agent stream exceeded its total event cap of ${lim.maxStreamEvents}`, false);
          }
          yield ev;
        }
        continue;
      }
      if (line.startsWith(":")) continue; // comment

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "data") {
        dataLines.push(value);
        eventLen += value.length + 1;
        if (dataLines.length > lim.maxDataLines) {
          throw new BridgeStreamError("agent stream event exceeded its data-line cap");
        }
        if (eventLen > lim.maxEventLen) {
          throw new BridgeStreamError("agent stream event exceeded its size cap");
        }
      } else if (field === "event") event = value;
      else if (field === "id") id = value;
      // "retry" and unknown fields are ignored
    }
    // After consuming every complete line, the remainder is one unterminated line. A stream
    // that never sends a newline grows this without bound, so cap it here.
    if (buffer.length > lim.maxBufferLen) {
      throw new BridgeStreamError("agent stream exceeded its buffer cap with no line break");
    }
  }
  const ev = flush();
  if (ev) {
    if (++eventCount > lim.maxStreamEvents) {
      throw new BridgeStreamError(`agent stream exceeded its total event cap of ${lim.maxStreamEvents}`, false);
    }
    yield ev;
  }
}
