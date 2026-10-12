import type { Membership } from "../roles";
import {
  MAX_AGENT_JOB_CHARS,
  agentDidForHandle,
  completeMention,
  handleProblem,
  isValidHandle,
  mentionQuery,
  normalizeHandle,
  normalizeJob,
  suggestAgents,
  suggestHandle,
  systemPromptFor,
  typedMentions,
  uniqueAgentName,
} from "../agents";
import { threadToChatMessages } from "../routing";
import { BondOwnGatewayAdapter } from "../../bridge/adapters/own";
import { setFetchImpl } from "../../bridge/net";
import type { BondNode, Identity } from "../../model/node";

const agent = (did: string, displayName: string, handle?: string): Membership => ({
  did,
  displayName,
  kind: "agent",
  role: "agent",
  joinedAt: "",
  bridgeId: "bond",
  handle,
});
const human: Membership = { did: "did:key:zH", displayName: "Ada", kind: "human", role: "owner", joinedAt: "" };
const room = [human, agent("did:bond:assistant", "Bond", "bond"), agent("d2", "Payments Watcher", "payments"), agent("d3", "Scout", "scout")];

describe("handles", () => {
  it("normalizes what the user types", () => {
    expect(normalizeHandle("  @@Pay-Watch 1 ")).toBe("paywatch1");
  });
  it("validates shape and uniqueness", () => {
    expect(isValidHandle("ab")).toBe(false);
    expect(isValidHandle("1abc")).toBe(false);
    expect(isValidHandle("abc")).toBe(true);
    expect(handleProblem("scout", ["scout"])).toMatch(/already/);
    expect(handleProblem("x", [])).toMatch(/letters/);
    expect(handleProblem("newbie", ["scout"])).toBeNull();
  });
  it("suggests a free handle from a name", () => {
    expect(suggestHandle("Payments Watcher", [])).toBe("payments_watcher");
    expect(suggestHandle("Payments Watcher", ["payments_watcher"])).toBe("payments_watcher_2");
    expect(suggestHandle("42", [])).toBe("agent_42");
    expect(isValidHandle(suggestHandle("", []))).toBe(true);
  });
  it("derives a did unique per handle", () => {
    expect(agentDidForHandle("scout")).toBe("did:bond:agent:@scout");
  });
});

describe("typed @mentions", () => {
  it("addresses an agent by @handle or @Name, case-insensitive", () => {
    expect(typedMentions("hey @scout what's up", room)).toEqual(["d3"]);
    expect(typedMentions("@Payments Watcher check this", room)).toEqual(["d2"]);
    expect(typedMentions("@BOND and @scout", room)).toEqual(["did:bond:assistant", "d3"]);
  });
  it("needs a whole word and never matches humans or emails", () => {
    expect(typedMentions("@scouting", room)).toEqual([]);
    expect(typedMentions("mail me at x@scout", room)).toEqual([]);
    expect(typedMentions("@Ada hi", room)).toEqual([]);
    expect(typedMentions("no mention", room)).toEqual([]);
  });
  it("drives the composer's suggestions", () => {
    expect(mentionQuery("hello @sc")).toBe("sc");
    expect(mentionQuery("hello @")).toBe("");
    expect(mentionQuery("mail x@sc")).toBeNull();
    expect(mentionQuery("@scout done ")).toBeNull();
    expect(suggestAgents("pa", room).map((a) => a.did)).toEqual(["d2"]);
    expect(suggestAgents("watch", room).map((a) => a.did)).toEqual(["d2"]);
    expect(completeMention("hi @sc", "scout")).toBe("hi @scout ");
  });
});

describe("names in a room", () => {
  it("numbers a name that is already taken, case-insensitively", () => {
    expect(uniqueAgentName("Bond", [])).toBe("Bond");
    expect(uniqueAgentName("Bond", [agent("a", "Bond"), agent("b", "bond 2")])).toBe("Bond 3");
    expect(uniqueAgentName("  ", [])).toBe("Agent");
  });
  it("normalizes a job", () => {
    expect(normalizeJob("  watch  ")).toBe("watch");
    expect(normalizeJob(" ")).toBeUndefined();
    expect(normalizeJob("a".repeat(MAX_AGENT_JOB_CHARS + 9))!.length).toBe(MAX_AGENT_JOB_CHARS);
  });
});

describe("prompt and transcript for one agent", () => {
  it("names the agent, keeps its persona and job, all on safe one-line quotes", () => {
    const p = systemPromptFor("Base.", { name: "Scout", handle: "scout", persona: 'dry "wit"\nterse', job: "watch SOL" });
    expect(p).toContain('you are "Scout" (@scout)');
    expect(p).toContain(`persona, in the owner's words: "dry 'wit' terse"`);
    expect(p).toContain('"watch SOL"');
    expect(p).not.toContain("\n");
    expect(systemPromptFor("Base.", {})).toBe("Base.");
  });
  it("shows other agents' replies as labelled user turns", () => {
    const mk = (author: Identity, body: string, i: number): BondNode => ({
      id: String(i), roomId: "r", parentId: null, lamport: i, createdAt: "", author, type: "text", payload: { body },
    });
    const nodes = [
      mk({ did: "did:key:zH", displayName: "Ada", kind: "human" }, "@scout @bond hi", 1),
      mk({ did: "d3", displayName: "Scout", kind: "agent" }, "Scout here", 2),
      mk({ did: "did:bond:assistant", displayName: "Bond", kind: "agent" }, "Bond here", 3),
    ];
    expect(threadToChatMessages(nodes, undefined, "d3")).toEqual([
      { role: "user", content: "@scout @bond hi" },
      { role: "assistant", content: "Scout here" },
      { role: "user", content: "[Bond, another agent]: Bond here" },
    ]);
  });
});

describe("on the wire", () => {
  it("sends job, persona, name and handle to the Bond runtime, omitting what is unset", async () => {
    const bodies: Record<string, unknown>[] = [];
    setFetchImpl((async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return new Response('data: {"kind":"done"}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as never);
    const a = new BondOwnGatewayAdapter();
    await a.connect({ baseUrl: "https://bond.example/v1", getToken: async () => "bs1.t" });
    const run = async (extra: Record<string, string>) => {
      const events = [];
      for await (const e of a.sendTurn({ threadId: "t", messages: [{ role: "user", content: "hi" }], ...extra })) {
        events.push(e);
      }
      expect(events.map((e) => e.kind)).toEqual(["done"]);
    };
    await run({ job: "J", persona: "P", agentName: "Scout", agentHandle: "scout" });
    await run({});
    expect(bodies[0]).toMatchObject({ job: "J", persona: "P", agentName: "Scout", agentHandle: "scout" });
    for (const k of ["job", "persona", "agentName", "agentHandle"]) expect(k in bodies[1]!).toBe(false);
  });
});
