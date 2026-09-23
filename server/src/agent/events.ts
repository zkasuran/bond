// The AdapterEvent contract, mirrored on the server side. This is the exact
// shape the app's bridge consumes (app/src/bridge/adapter.ts). The agent route
// serialises one of these per SSE message so the app's bond adapter can yield
// them straight through with no translation.
//
// Kept as a standalone copy on purpose: the server does not import from the app
// (different build, different tsconfig root). If the app contract changes, this
// copy changes with it.
export type AdapterEvent =
  | { kind: "turn_start"; runId?: string; agentId?: string }
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; id: string; name: string; args: unknown }
  | { kind: "tool_result"; id: string; result: unknown; isError?: boolean }
  | { kind: "turn_end"; runId?: string }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "done" };

// Serialise an AdapterEvent as one SSE message. The event name carries the kind
// so a reader can switch on the SSE `event:` line. The JSON body carries the
// whole event so a reader can also just JSON.parse the `data:` line. Bond's
// SSE parser (app/src/bridge/sse.ts) exposes both.
export function sseFor(event: AdapterEvent): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

// Normalise any thrown value to a short message without leaking a stack.
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
