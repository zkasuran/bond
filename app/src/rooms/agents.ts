// Agents as people in the chat. Every agent you create gets a profile: a name, a unique
// @handle and a persona (who it is and how it talks). The profile is yours and travels: bring
// the same agent into any other room by its @handle and it keeps its persona there. What it
// works on can differ per room, so the job lives on the room membership, not the profile.
// In a thread, address one agent by typing its @handle (or @Name), or tap its chip; only the
// agents addressed reply. See DESIGN.md sec 6.
import type { Membership } from "./roles";

/** Must match MAX_AGENT_JOB_CHARS / MAX_AGENT_PERSONA_CHARS in server/src/agent/route.ts. */
export const MAX_AGENT_JOB_CHARS = 600;
export const MAX_AGENT_PERSONA_CHARS = 600;
export const MAX_AGENT_NAME_CHARS = 40;
export const MIN_HANDLE_CHARS = 3;
export const MAX_HANDLE_CHARS = 20;

/** The built-in assistant every room starts with. */
export const BOND_AGENT_DID = "did:bond:assistant";
export const BOND_AGENT_HANDLE = "bond";

/** An agent you own, reusable across rooms by its @handle. */
export interface AgentProfile {
  did: string;
  /** Unique among your agents, lowercase, no @. Fixed once created. */
  handle: string;
  displayName: string;
  /** The bridge (runtime) that runs it. */
  bridgeId: string;
  /** Who the agent is and how it talks, in the owner's words. Same in every room. */
  persona?: string;
  createdAt: string;
}

/** Text as stored: trimmed and capped. Empty means none. */
function capText(raw: string | undefined | null, max: number): string | undefined {
  const v = (raw ?? "").trim().slice(0, max).trim();
  return v || undefined;
}
export const normalizeJob = (raw: string | undefined | null) => capText(raw, MAX_AGENT_JOB_CHARS);
export const normalizePersona = (raw: string | undefined | null) =>
  capText(raw, MAX_AGENT_PERSONA_CHARS);

/** A handle as typed, cleaned: no leading @, lowercase, letters, digits and _ only. */
export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, MAX_HANDLE_CHARS);
}

/** A handle starts with a letter and is 3 to 20 of a-z, 0-9 and _. */
export function isValidHandle(handle: string): boolean {
  return new RegExp(`^[a-z][a-z0-9_]{${MIN_HANDLE_CHARS - 1},${MAX_HANDLE_CHARS - 1}}$`).test(handle);
}

/** Why a handle cannot be used, or null when it can. */
export function handleProblem(handle: string, taken: Iterable<string>): string | null {
  if (!isValidHandle(handle)) {
    return `Use ${MIN_HANDLE_CHARS} to ${MAX_HANDLE_CHARS} letters, digits or _, starting with a letter.`;
  }
  for (const t of taken) if (t === handle) return `@${handle} is already one of your agents.`;
  return null;
}

/** A free handle derived from a name: "Payments Watcher" -> "payments_watcher", then _2, _3. */
export function suggestHandle(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_HANDLE_CHARS - 3);
  if (!/^[a-z]/.test(base)) base = `agent${base ? `_${base}` : ""}`.slice(0, MAX_HANDLE_CHARS - 3);
  while (base.length < MIN_HANDLE_CHARS) base += "_";
  if (!used.has(base) && isValidHandle(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The did of an agent created with a handle. Handles are unique, so the did is too, and the
 *  "@" keeps it apart from the older per-bridge dids (did:bond:agent:<bridgeId>[:<suffix>]). */
export function agentDidForHandle(handle: string): string {
  return `did:bond:agent:@${handle}`;
}

/** A display name that is not already taken in the room: "Bond", then "Bond 2", "Bond 3"... */
export function uniqueAgentName(base: string, members: Membership[]): string {
  const clean = base.trim().slice(0, MAX_AGENT_NAME_CHARS).trim() || "Agent";
  const taken = new Set(members.map((m) => m.displayName.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let n = 2; ; n++) {
    const candidate = `${clean} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The agents a message addresses by typing: "@handle" or "@Display Name", case-insensitive,
 *  as a whole word (so "@bond2" does not address @bond). Returns their dids in room order. */
export function typedMentions(body: string, members: Membership[]): string[] {
  const out: string[] = [];
  for (const m of members) {
    if (m.kind !== "agent") continue;
    const names = [m.handle, m.displayName].filter((x): x is string => !!x && x.trim().length > 0);
    const hit = names.some((n) =>
      new RegExp(`(^|[^\\w@])@${escapeRegExp(n.trim())}(?![\\w])`, "i").test(body),
    );
    if (hit) out.push(m.did);
  }
  return out;
}

/** The partial "@han" being typed at the end of the text, or null. Drives the composer's
 *  agent suggestions. */
export function mentionQuery(text: string): string | null {
  const m = /(^|\s)@([a-zA-Z0-9_]*)$/.exec(text);
  return m ? m[2]!.toLowerCase() : null;
}

/** Replace the "@par" being typed at the end with "@handle ". */
export function completeMention(text: string, handle: string): string {
  return text.replace(/@([a-zA-Z0-9_]*)$/, `@${handle} `);
}

/** The agents to suggest for a partial: handle or name starts with it. */
export function suggestAgents(query: string, agents: Membership[]): Membership[] {
  const q = query.toLowerCase();
  return agents.filter(
    (a) =>
      a.kind === "agent" &&
      ((a.handle ?? "").startsWith(q) ||
        a.displayName.toLowerCase().startsWith(q) ||
        a.displayName.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))),
  );
}

/** One quoted line: line breaks folded, double quotes swapped, so the text cannot break out. */
function quoted(s: string): string {
  return s.replace(/\s+/g, " ").replace(/"/g, "'").trim();
}

/** The client-side system prompt with the agent's name, persona and job appended, for bridges
 *  that take their instructions from the transcript. The Bond runtime ignores this and builds
 *  the same lines server-side from the persona, name, handle and job fields. */
export function systemPromptFor(
  base: string,
  agent: { name?: string; handle?: string; persona?: string; job?: string },
): string {
  const parts = [base];
  if (agent.name) {
    parts.push(
      `In this room you are "${quoted(agent.name)}"${agent.handle ? ` (@${agent.handle})` : ""}. Other agents may be in the room; answer only as yourself.`,
    );
  }
  if (agent.persona) {
    parts.push(
      `Your persona, in the owner's words: "${quoted(agent.persona)}". Stay in it in every reply.`,
    );
  }
  if (agent.job) {
    parts.push(
      `The room owner gave you this standing job in this room, in their own words: "${quoted(agent.job)}". Pursue it whenever a request fits it.`,
    );
  }
  return parts.join(" ");
}
