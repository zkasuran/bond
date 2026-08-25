import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { config } from "./config.js";

// Strip a trailing slash so base + path never doubles up.
function base(): string {
  return config.openaiBaseUrl.replace(/\/+$/, "");
}

// Pipe an upstream fetch Response back to the client, status and content
// type carried through. When the caller asked to stream we force the
// event-stream content type so SSE reaches the browser unbuffered.
function relay(
  reply: FastifyReply,
  upstream: Response,
  streaming: boolean,
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
    return reply.send(null);
  }
  // upstream.body is a web ReadableStream. Readable.fromWeb adapts it to a
  // Node stream that Fastify pipes straight to the socket.
  return reply.send(Readable.fromWeb(upstream.body as never));
}

export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  // OpenAI-compatible chat completions. Body is passed through untouched
  // apart from defaulting the model when the client leaves it out.
  app.post("/v1/chat/completions", async (request, reply) => {
    const body =
      request.body != null && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    if (body.model == null || body.model === "") {
      body.model = config.openaiModel;
    }
    const streaming = body.stream === true;

    let upstream: Response;
    try {
      upstream = await fetch(`${base()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      request.log.error(err, "upstream chat/completions request failed");
      return reply.code(502).send({ error: "upstream request failed" });
    }
    return relay(reply, upstream, streaming);
  });

  // Model list, proxied through so the app can populate its picker.
  app.get("/v1/models", async (request, reply) => {
    let upstream: Response;
    try {
      upstream = await fetch(`${base()}/models`, {
        headers: { authorization: `Bearer ${config.openaiApiKey}` },
      });
    } catch (err) {
      request.log.error(err, "upstream models request failed");
      return reply.code(502).send({ error: "upstream request failed" });
    }
    return relay(reply, upstream, false);
  });
}
