// The agent turn route. POST /v1/agent/turn runs the tool-calling loop and
// streams AdapterEvent messages as SSE, one event per message, so the app's
// bond adapter can consume them with no translation. Sits behind the same
// bearer auth as the rest of /v1 (enforced in index.ts).
import { parseClaims, issueSkillChallenge } from "./skills.js";
import type { FastifyInstance } from "fastify";
import type { ModelMessage } from "ai";
import { runAgentTurn } from "./loop.js";
import { sseFor, errText } from "./events.js";
import { MAX_AGENT_STEPS } from "../limits.js";

interface RawMessage {
  role?: string;
  content?: unknown;
}

// Ceilings on the client-supplied conversation. limits.ts is owned by another
// engineer right now, so these live here as local named constants until they
// move there. They bound the upstream prompt a caller can inflate.
export const MAX_AGENT_MESSAGES = 64;
export const MAX_AGENT_MESSAGE_CHARS = 24_000;

// Keep only the roles the model prompt accepts, with string content. Tool and
// unknown roles are dropped, because the server runs the tool loop itself and
// never expects the client to feed tool turns back. A client-supplied system
// message is dropped too: the system prompt is set server-side only, so the
// client cannot inject one with system authority. The count is bounded to the
// most recent MAX_AGENT_MESSAGES and each message to MAX_AGENT_MESSAGE_CHARS so a
// huge history or a giant string cannot inflate the upstream prompt or memory.
export function toModelMessages(raw: unknown): ModelMessage[] {
  if (!Array.isArray(raw)) return [];
  const recent =
    raw.length > MAX_AGENT_MESSAGES ? raw.slice(raw.length - MAX_AGENT_MESSAGES) : raw;
  const out: ModelMessage[] = [];
  for (const m of recent as RawMessage[]) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;
    let content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (content.length > MAX_AGENT_MESSAGE_CHARS) content = content.slice(0, MAX_AGENT_MESSAGE_CHARS);
    out.push({ role, content });
  }
  return out;
}

// Ceilings on an agent's standing job, persona and name. Must match app/src/rooms/agents.ts.
export const MAX_AGENT_JOB_CHARS = 600;
export const MAX_AGENT_PERSONA_CHARS = 600;
export const MAX_AGENT_NAME_CHARS = 40;

// The agent's standing job from the request body: a string, with control characters and line
// breaks folded to single spaces (it is quoted inside the system prompt, so it cannot open a
// new line there), double quotes swapped for single so it cannot close that quote, trimmed and
// capped. Anything else, or an empty result, means no job.
export function sanitizeJob(raw: unknown, max: number = MAX_AGENT_JOB_CHARS): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return clean || undefined;
}

/** The agent's persona: the same folding as a job, with its own cap. */
export const sanitizePersona = (raw: unknown) => sanitizeJob(raw, MAX_AGENT_PERSONA_CHARS);
/** The agent's display name: one quoted-safe line, 40 chars. */
export const sanitizeAgentName = (raw: unknown) => sanitizeJob(raw, MAX_AGENT_NAME_CHARS);
/** The agent's @handle: 3 to 20 of a-z, 0-9 and _, starting with a letter; anything else is dropped. */
export function sanitizeHandle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return /^[a-z][a-z0-9_]{2,19}$/.test(raw) ? raw : undefined;
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // A short-lived, stateless freshness challenge for skill-claim proofs (F14 HIGH). The app
  // echoes it inside the wallet-ownership proof it signs, so a captured claim bundle cannot be
  // replayed after the window. No per-user state: it is an HMAC the server re-checks. Sits
  // behind the same bearer auth as the rest of /v1 (enforced in index.ts).
  app.get("/v1/agent/skill-challenge", async () => ({ challenge: issueSkillChallenge() }));

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
    // The room owner's standing job for this agent. Quoted into the system prompt as a user
    // request; the fixed rules and the code-enforced caps still apply.
    const job = sanitizeJob(body.job);
    // The agent's identity in a multi-agent room and its persona (who it is, how it talks).
    const persona = sanitizePersona(body.persona);
    const agentName = sanitizeAgentName(body.agentName);
    const agentHandle = sanitizeHandle(body.agentHandle);
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
      // The stream is hijacked, so the app-wide header hook never runs on it.
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
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
        job,
        persona,
        agentName,
        agentHandle,
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
