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

// Concurrent in-flight proxy requests. A request past the ceiling is refused
// rather than opening an unbounded number of sockets to the upstream.
let inFlight = 0;

// Fetch the upstream with a hard timeout on the response headers. The timer is
// cleared the moment the response resolves, so a long legitimate stream is
// bounded by MAX_UPSTREAM_BYTES rather than being cut off mid-stream.
async function fetchUpstream(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Adapt a web ReadableStream to a Node stream that errors once it has relayed
// more than maxBytes, so a hostile or broken upstream cannot stream without end.
function capStream(web: WebReadableStream, maxBytes: number): Readable {
  const node = Readable.fromWeb(web);
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) {
        cb(new Error("upstream response exceeded the relay byte cap"));
        return;
      }
      cb(null, chunk);
    },
  });
  node.on("error", (err) => counter.destroy(err));
  return node.pipe(counter);
}

// Pipe an upstream fetch Response back to the client, status and content type
// carried through. onDone fires once the relay has finished or failed, so the
// caller can release its concurrency slot exactly once.
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

    if (inFlight >= MAX_CONCURRENT_UPSTREAM) {
      return reply.code(503).send({ error: "too many upstream requests in flight" });
    }
    inFlight += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };

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
    return relay(reply, upstream, streaming, release);
  });

  // Model list, proxied through so the app can populate its picker.
  app.get("/v1/models", async (request, reply) => {
    if (inFlight >= MAX_CONCURRENT_UPSTREAM) {
      return reply.code(503).send({ error: "too many upstream requests in flight" });
    }
    inFlight += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };

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
    return relay(reply, upstream, false, release);
  });
}
