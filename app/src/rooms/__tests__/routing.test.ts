import type { BondNode, Identity } from "../../model/node";
import type { Membership } from "../roles";
import { agentMentions, threadToChatMessages } from "../routing";

const human: Identity = { did: "did:key:zHuman", displayName: "Ada", kind: "human" };
const agentId = "did:bond:assistant";

function textNode(author: Identity, body: string, mentions?: string[]): BondNode {
  return {
    id: `${author.did}:${body}`,
    roomId: "r",
    parentId: null,
    lamport: 1,
    createdAt: new Date(0).toISOString(),
    author,
    type: "text",
    payload: { body, mentions },
  };
}

const members: Membership[] = [
  { did: human.did, displayName: "Ada", kind: "human", role: "owner", joinedAt: "" },
  { did: agentId, displayName: "Bond", kind: "agent", role: "agent", joinedAt: "" },
];

describe("mention routing", () => {
  it("returns only the mentioned agent members", () => {
    const node = textNode(human, "hey @Bond", [agentId]);
    expect(agentMentions(node, members).map((m) => m.did)).toEqual([agentId]);
  });

  it("returns nothing when no agent is mentioned", () => {
    const node = textNode(human, "just a note");
    expect(agentMentions(node, members)).toEqual([]);
  });
});

describe("thread transcript", () => {
  it("maps humans to user, agents to assistant, and prepends the system prompt", () => {
    const agent: Identity = { did: agentId, displayName: "Bond", kind: "agent" };
    const msgs = threadToChatMessages(
      [textNode(human, "hello"), textNode(agent, "hi there")],
      "system rules",
    );
    expect(msgs).toEqual([
      { role: "system", content: "system rules" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });
});
