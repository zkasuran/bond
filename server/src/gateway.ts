import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { config } from "./config.js";
import {
  UPSTREAM_TIMEOUT_MS,
  MAX_UPSTREAM_BYTES,
  MAX_CONCURRENT_UPSTREAM,
} from "./limits.js";

// Strip a trailing slash so base + path never doubles up.
function base(): string {
  return config.openaiBaseUrl.replace(/\/+$/, "");
}

// Local ceilings. limits.ts is owned by another engineer right now, so these live
// here as local named constants until they move there.
//
// Most slots one client (keyed the same way the rate limiter keys, request.ip)
// may hold at once, applied ONLY when request.ip is a trusted per-client
// identifier (see perKeyCapEnforced). A single slow reader can then take at most
// this many, so it cannot starve every other caller of the shared pool.
export const MAX_CONCURRENT_UPSTREAM_PER_KEY = 6;
// If no body chunk arrives within this window the relay is torn down, so a
// slow-loris upstream that trickles the body cannot hold a socket and a slot open.
const UPSTREAM_BODY_IDLE_MS = 20_000;
// Overall wall-clock ceiling on relaying one upstream body, whatever its pacing.
// The idle timer above resets on every chunk, so a body that trickles just under
// the idle window (a byte every 19s) resets it forever and holds a slot and a
// socket for effectively unbounded time. This deadline is absolute: the whole
// relay must finish inside it or it is torn down, idle timer notwithstanding.
// Generous so a long legitimate stream is never cut, finite so a slow trickle
// cannot pin a slot. Local, not in limits.ts, by the same ownership note above.
const UPSTREAM_BODY_TOTAL_MS = 5 * 60_000;

// Concurrent in-flight proxy requests, globally and per client key. A request
// past either ceiling is refused rather than opening unbounded sockets upstream.
let inFlightGlobal = 0;
const inFlightByKey = new Map<string, number>();

// Whether the per-key cap is enforced. It gives real per-client isolation only
// when request.ip is a trusted per-client identifier, which depends on how the
// gateway is deployed. Fastify resolves request.ip from X-Forwarded-For only when
// TRUST_PROXY names the proxy:
//   - TRUST_PROXY=<proxy-ip-or-cidr>: request.ip is the real client the proxy
//     wrote, so the per-key cap isolates one client from another. Enforced.
//   - TRUST_PROXY unset or false, behind a reverse proxy: request.ip collapses to
//     the one proxy socket address every client shares, so a per-key cap of a
//     handful would throttle the whole fleet to that handful and one caller could
//     deny the proxy to all. NOT enforced, so throughput does not collapse.
//   - TRUST_PROXY=true: request.ip is the leftmost X-Forwarded-For, which the
//     client sets, so the cap is trivially bypassed by rotating it. NOT enforced.
// In the unenforced cases the global cap plus the per-chunk idle and overall body
// deadlines still bound total resource use. Correct per-client limiting therefore
// REQUIRES running the gateway behind a proxy that sets a trusted client
// identifier (TRUST_PROXY=<proxy-cidr>); any other deployment gets only the global
// bound, by design.
function perKeyCapEnforced(): boolean {
  return typeof config.trustProxy === "string";
}

// Reserve a slot for one client key. Returns a release function, or null when the
// global pool is full or (where the key is a trusted client id) this client
// already holds its share. Release is idempotent so a double release cannot drive
// the counters negative.
export function acquireSlot(key: string): (() => void) | null {
  if (inFlightGlobal >= MAX_CONCURRENT_UPSTREAM) return null;
  const held = inFlightByKey.get(key) ?? 0;
  if (perKeyCapEnforced() && held >= MAX_CONCURRENT_UPSTREAM_PER_KEY) return null;
  inFlightGlobal += 1;
  inFlightByKey.set(key, held + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightGlobal -= 1;
    const n = (inFlightByKey.get(key) ?? 1) - 1;
    if (n <= 0) inFlightByKey.delete(key);
    else inFlightByKey.set(key, n);
  };
}

// Fetch the upstream with a hard timeout on the response headers. Redirects are
// not followed: a compromised or MITM'd upstream must not be able to 302 the
// relay at an internal address, so a 3xx is returned and handled as an error.
async function fetchUpstream(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Adapt a web ReadableStream to a Node stream that errors once it has relayed more
// than maxBytes, once no chunk has arrived for idleMs, or once the whole body has
// run past totalMs, so a hostile or broken upstream can neither stream without end
// nor stall or trickle the body to hold a socket.
export function capStream(
  web: WebReadableStream,
  maxBytes: number,
  idleMs = UPSTREAM_BODY_IDLE_MS,
  totalMs = UPSTREAM_BODY_TOTAL_MS,
): Readable {
  const node = Readable.fromWeb(web);
  let seen = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let overall: ReturnType<typeof setTimeout> | undefined;
  const arm = (t: Transform): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => t.destroy(new Error("upstream body idle timeout")), idleMs);
  };
  const disarm = (): void => {
    if (idle) clearTimeout(idle);
    idle = undefined;
    if (overall) clearTimeout(overall);
    overall = undefined;
  };
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) {
        disarm();
        cb(new Error("upstream response exceeded the relay byte cap"));
        return;
      }
      arm(this);
      cb(null, chunk);
    },
    flush(cb) {
      disarm();
      cb();
    },
  });
  arm(counter);
  // Absolute deadline, reset by nothing. A body that trickles just under the idle
  // window keeps re-arming the idle timer forever, so only this can stop it.
  overall = setTimeout(() => counter.destroy(new Error("upstream body total timeout")), totalMs);
  node.on("error", (err) => counter.destroy(err));
  counter.on("close", () => {
    disarm();
    // A .pipe() destination destroy does not tear down its source, so destroy the
    // source here or the undici upstream body stays locked and the socket lingers
    // even after the concurrency slot has been freed. Safe on a clean end too.
    if (!node.destroyed) node.destroy();
  });
  return node.pipe(counter);
}

// Pipe an upstream fetch Response back to the client, status and content type
// carried through. onDone fires once the relay has finished or failed, so the
// caller can release its concurrency slot exactly once. Only content-type is ever
// reflected from the upstream response: no credential-bearing header (set-cookie,
// www-authenticate, authorization) is forwarded, so the upstream cannot push a
// secret back to the client through a response header.
function relay(
  reply: FastifyReply,
  upstream: Response,
  streaming: boolean,
  onDone: () => void,
): FastifyReply {
  reply.code(upstream.status);
  if (streaming) {
    reply.header("content-type", "text/event-stream");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
  } else {
    reply.header(
      "content-type",
      upstream.headers.get("content-type") ?? "application/json",
    );
  }
  if (!upstream.body) {
    onDone();
    return reply.send(null);
  }
  const stream = capStream(upstream.body as unknown as WebReadableStream, MAX_UPSTREAM_BYTES);
  stream.once("close", onDone);
  return reply.send(stream);
}

// Relay a 2xx upstream response, or send a fixed generic error for a non-2xx one.
// A non-2xx upstream body is never piped to the client: an OpenAI-compatible
// router often echoes the sent credential or request headers in a verbose error
// body, so relaying it verbatim could leak the upstream key back. The body is
// cancelled to free the socket, the detail is logged server side only.
function relayOrError(
  reply: FastifyReply,
  upstream: Response,
  streaming: boolean,
  onDone: () => void,
): FastifyReply {
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {});
    onDone();
    reply.log.warn({ status: upstream.status }, "upstream returned a non-2xx status");
    return reply
      .code(upstream.status)
      .send({ error: "upstream request failed", status: upstream.status });
  }
  // A 2xx body is relayed verbatim. We do not scan it for an echoed credential:
  // the upstream is a fixed, env-pinned, trusted endpoint (config.openaiBaseUrl),
  // not a client-controlled host, so a 200 body echoing our own key is out of the
  // threat model. Only the request body is attacker-influenced, never the host.
  return relay(reply, upstream, streaming, onDone);
}

export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  // OpenAI-compatible chat completions. Body is passed through untouched apart
  // from defaulting the model when the client leaves it out. The client's own
  // Authorization header (the Bond bearer) is never read here, so it is never
  // forwarded upstream: the upstream key below is the only credential sent.
  app.post("/v1/chat/completions", async (request, reply) => {
    const body =
      request.body != null && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    if (body.model == null || body.model === "") {
      body.model = config.openaiModel;
    }
    const streaming = body.stream === true;

    const release = acquireSlot(request.ip);
    if (!release) {
      return reply.code(503).send({ error: "too many upstream requests in flight" });
    }

    let upstream: Response;
    try {
      upstream = await fetchUpstream(`${base()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      release();
      request.log.error(err, "upstream chat/completions request failed");
      return reply.code(502).send({ error: "upstream request failed" });
    }
    return relayOrError(reply, upstream, streaming, release);
  });

  // Model list, proxied through so the app can populate its picker.
  app.get("/v1/models", async (request, reply) => {
    const release = acquireSlot(request.ip);
    if (!release) {
      return reply.code(503).send({ error: "too many upstream requests in flight" });
    }

    let upstream: Response;
    try {
      upstream = await fetchUpstream(`${base()}/models`, {
        headers: { authorization: `Bearer ${config.openaiApiKey}` },
      });
    } catch (err) {
      release();
      request.log.error(err, "upstream models request failed");
      return reply.code(502).send({ error: "upstream request failed" });
    }
    return relayOrError(reply, upstream, false, release);
  });
}
