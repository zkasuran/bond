// The agent turn route. POST /v1/agent/turn runs the tool-calling loop and
// streams AdapterEvent messages as SSE, one event per message, so the app's
// bond adapter can consume them with no translation. Sits behind the same
// bearer auth as the rest of /v1 (enforced in index.ts).
import { parseClaims } from "./skills.js";
import type { FastifyInstance } from "fastify";
import type { ModelMessage } from "ai";
import { runAgentTurn } from "./loop.js";
import { sseFor, errText } from "./events.js";
import { MAX_AGENT_STEPS } from "../limits.js";

interface RawMessage {
  role?: string;
  content?: unknown;
}

// Keep only the roles the model prompt accepts, with string content. Tool and
// unknown roles are dropped, because the server runs the tool loop itself and
// never expects the client to feed tool turns back.
function toModelMessages(raw: unknown): ModelMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelMessage[] = [];
  for (const m of raw as RawMessage[]) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    out.push({ role, content });
  }
  return out;
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/agent/turn", async (request, reply) => {
    const body =
      request.body != null && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};

    const messages = toModelMessages(body.messages);
    if (messages.length === 0) {
      return reply.code(400).send({ error: "messages must be a non-empty array" });
    }

    const provider = typeof body.provider === "string" ? body.provider : undefined;
    const model = typeof body.model === "string" ? body.model : undefined;
    const runId = typeof body.runId === "string" ? body.runId : undefined;
    // Purchase signatures the app holds. Each is verified on chain before its skill unlocks.
    const skills = parseClaims(body.skills);
    // The step count is clamped to the hard ceiling. A client that asks for more
    // (or a non-number) gets MAX_AGENT_STEPS, never an unbounded loop. The system
    // prompt is fixed on the server and is not read from the body.
    const requested = typeof body.maxSteps === "number" ? Math.floor(body.maxSteps) : MAX_AGENT_STEPS;
    const maxSteps = Math.max(1, Math.min(requested, MAX_AGENT_STEPS));

    // Abort the model call and tool work only when the client hangs up before
    // the turn is done. The finished flag stops the normal end-of-stream close
    // from being read as a disconnect.
    const ac = new AbortController();
    let finished = false;
    reply.raw.on("close", () => {
      if (!finished) ac.abort();
    });

    // Take over the socket and write SSE frames directly. Draining the event
    // generator inline keeps the model stream fed, the same way an in-process
    // consumer would, so nothing is starved into an early cancel.
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Defeat proxy buffering so events reach the client as they are produced.
      "x-accel-buffering": "no",
    });
    reply.hijack();

    try {
      for await (const event of runAgentTurn({
        messages,
        provider,
        model,
        maxSteps,
        signal: ac.signal,
        runId,
        skills,
      })) {
        reply.raw.write(sseFor(event));
      }
    } catch (err) {
      reply.raw.write(sseFor({ kind: "error", message: errText(err), retryable: false }));
      reply.raw.write(sseFor({ kind: "done" }));
    } finally {
      finished = true;
      reply.raw.end();
    }
  });
}
