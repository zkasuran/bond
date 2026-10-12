// Agent members of a room. Each added agent gets its own did, so the same bridge can supply
// several agents to one room, each with its own name and standing job (what the room owner
// wants it to pursue). The job is sent with every turn; the Bond runtime quotes it into its
// fixed system prompt and the spend caps stay in code. See DESIGN.md sec 6.
import type { Membership } from "./roles";

/** Must match MAX_AGENT_JOB_CHARS in server/src/agent/route.ts. */
export const MAX_AGENT_JOB_CHARS = 600;
export const MAX_AGENT_NAME_CHARS = 40;

/** A job as stored: trimmed and capped. Line breaks are kept here for editing; the server
 *  folds them. Empty means no job. */
export function normalizeJob(raw: string | undefined | null): string | undefined {
  const job = (raw ?? "").trim().slice(0, MAX_AGENT_JOB_CHARS).trim();
  return job || undefined;
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

/** A did for a new agent member on a bridge, unique within the room. The first agent from a
 *  bridge keeps the historical `did:bond:agent:<bridgeId>` so existing rooms do not change. */
export function newAgentDid(bridgeId: string, members: Membership[], rand: () => string): string {
  const base = `did:bond:agent:${bridgeId}`;
  const taken = new Set(members.map((m) => m.did));
  if (!taken.has(base)) return base;
  for (;;) {
    const candidate = `${base}:${rand()}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The client-side system prompt with the agent's job appended, for bridges that take their
 *  instructions from the transcript. The Bond runtime ignores this and uses the job field. */
export function systemPromptWithJob(base: string, job: string | undefined): string {
  if (!job) return base;
  return `${base} The room owner gave you this standing job in this room, in their own words: "${job.replace(/\s+/g, " ").replace(/"/g, "'")}". Pursue it whenever a request fits it.`;
}
