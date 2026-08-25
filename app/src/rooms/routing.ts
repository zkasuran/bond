// Mention routing and thread-to-transcript mapping. A mention carries a member's stable
// did, not a display string, so routing to an agent is unambiguous. Mentioning an agent
// is the trigger to run it against the current thread. See DESIGN.md sec 6.
import type { BondNode, NodeRef } from "../model/node";
import type { ChatMessage } from "../bridge/adapter";
import { isType } from "../model/messages";
import type { Membership } from "./roles";

/** The agent members mentioned by a text node. */
export function agentMentions(node: BondNode, members: Membership[]): Membership[] {
  if (!isType(node, "text")) return [];
  const ids = new Set(node.payload.mentions ?? []);
  return members.filter((m) => m.kind === "agent" && ids.has(m.did));
}

/** Turn a linear branch of nodes into an OpenAI-style transcript for an adapter. Text is
 *  mapped by author kind; a mention prefix is stripped so the agent sees a clean prompt. */
export function threadToChatMessages(
  nodes: BondNode[],
  systemPrompt?: string,
): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
  for (const n of nodes) {
    if (!isType(n, "text")) continue;
    const body = n.payload.body.trim();
    if (!body) continue;
    msgs.push({ role: n.author.kind === "agent" ? "assistant" : "user", content: body });
  }
  return msgs;
}

export function handoffRef(targetNodeId: string): NodeRef {
  return { kind: "handoff", target: targetNodeId };
}

/** A stable idempotency key for a handoff, so a retried handoff does not spawn twice. */
export function handoffIdempotencyKey(fromNodeId: string, toAgentDid: string): string {
  return `${fromNodeId}:${toAgentDid}`;
}
