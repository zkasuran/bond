import type { Membership } from "../roles";
import {
  MAX_AGENT_JOB_CHARS,
  newAgentDid,
  normalizeJob,
  systemPromptWithJob,
  uniqueAgentName,
} from "../agents";
import { BondOwnGatewayAdapter } from "../../bridge/adapters/own";
import { setFetchImpl } from "../../bridge/net";

const agent = (did: string, displayName: string): Membership => ({
  did,
  displayName,
  kind: "agent",
  role: "agent",
  joinedAt: "",
  bridgeId: "bond",
});

describe("agent members", () => {
  it("keeps the historical did for the first agent from a bridge", () => {
    expect(newAgentDid("bond", [], () => "x")).toBe("did:bond:agent:bond");
  });

  it("gives a second agent from the same bridge its own did", () => {
    const members = [agent("did:bond:agent:bond", "Bond")];
    expect(newAgentDid("bond", members, () => "01abc")).toBe("did:bond:agent:bond:01abc");
  });

  it("retries the random suffix until the did is free", () => {
    const members = [agent("did:bond:agent:bond", "A"), agent("did:bond:agent:bond:1", "B")];
    const rolls = ["1", "2"];
    expect(newAgentDid("bond", members, () => rolls.shift()!)).toBe("did:bond:agent:bond:2");
  });

  it("numbers a name that is already taken in the room, case-insensitively", () => {
    const members = [agent("d1", "Bond"), agent("d2", "bond 2")];
    expect(uniqueAgentName("Bond", [])).toBe("Bond");
    expect(uniqueAgentName("Bond", members)).toBe("Bond 3");
    expect(uniqueAgentName("  ", [])).toBe("Agent");
  });

  it("normalizes a job: trims, caps, and treats blank as none", () => {
    expect(normalizeJob("  watch payments  ")).toBe("watch payments");
    expect(normalizeJob("   ")).toBeUndefined();
    expect(normalizeJob(undefined)).toBeUndefined();
    expect(normalizeJob("a".repeat(MAX_AGENT_JOB_CHARS + 50))!.length).toBe(MAX_AGENT_JOB_CHARS);
  });

  it("adds the job to the client system prompt on one line, quotes neutralized", () => {
    expect(systemPromptWithJob("Base.", undefined)).toBe("Base.");
    const p = systemPromptWithJob("Base.", 'Track "big"\npayments');
    expect(p).toContain(`in their own words: "Track 'big' payments".`);
    expect(p).not.toContain("\n");
  });
});

describe("the job on the wire", () => {
  it("sends the agent's job to the Bond runtime, and omits it when unset", async () => {
    const bodies: Record<string, unknown>[] = [];
    setFetchImpl((async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return new Response('data: {"kind":"done"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as never);
    const a = new BondOwnGatewayAdapter();
    await a.connect({ baseUrl: "https://bond.example/v1", getToken: async () => "bs1.t" });
    const run = async (job?: string) => {
      const events = [];
      for await (const e of a.sendTurn({ threadId: "t", messages: [{ role: "user", content: "hi" }], job })) {
        events.push(e);
      }
      expect(events.map((e) => e.kind)).toEqual(["done"]);
    };
    await run("Summarize payments");
    await run();
    expect(bodies[0]!.job).toBe("Summarize payments");
    expect("job" in bodies[1]!).toBe(false);
  });
});
