# Agentic messaging landscape: what Bond needs that Slack, Discord, Matrix and Zulip do not have

Research doc for Bond. Date 2026-08-25. Every threading and message-type claim
below is pinned to a primary source (the protocol spec, the API reference or the
official docs). Where a fact could not be verified from the primary source it is
called out inline as unverified rather than asserted.

## 1. The gap: consumer and team chat were built for humans typing prose

Telegram, WhatsApp, Slack and Discord all share one root assumption: the atomic
unit is a human-authored text message posted to a mostly linear timeline.
Everything else (reactions, edits, threads, attachments) hangs off that unit.
That assumption is fine for people. It breaks the moment the participants are
agents, because an agent conversation is not a stream of prose. It is a
branching computation: a plan fans out into tool calls, tool calls return
structured results, sub-agents spawn and rejoin, tasks run for minutes or hours,
and the interesting content is machine-readable state, not sentences.

Concretely, an agent-era app needs seven things none of the four incumbents
give you as first-class primitives:

1. A message model where a tool call, a tool result, a token-delta stream and a
   signed receipt are distinct typed objects, not text with markup glued on.
2. A conversation shape that is a tree or DAG, so a single turn can branch into
   parallel tool calls and sub-agent runs that later rejoin.
3. Forkable sub-threads: cheaply spin a branch off any node, explore it, then
   collapse or merge it, without polluting the parent timeline.
4. First-class long-running tasks with an explicit lifecycle (submitted,
   working, input-required, done, failed) rather than a message that just sits
   there looking sent.
5. Streaming as a native message state, not a series of edits to one message.
6. Verifiable identity and provenance on each message, so a receiver can check
   who (which agent, which key) produced a payload and that the bytes were not
   altered.
7. Presence and status that describe an agent's run state (idle, thinking,
   calling a tool, blocked on input), not just "online / typing".

The rest of this doc shows precisely where each incumbent threading model falls
down against those needs, then proposes Bond's data model.

## 2. Threading models, compared precisely

### 2.1 Slack: flat, two-level, timestamp-parented

Slack threading is single-level. Every message carries a `ts`, described in the
API as the "unique identifier of either a thread's parent message or a message
in the thread". A reply belongs to a thread by setting its `thread_ts` equal to
the parent message's `ts`. The parent tracks children with `reply_count` and
`reply_users` and each reply carries `parent_user_id`. There is no field that
lets a reply act as the parent of a further sub-thread, so the structure is
strictly root plus flat list of replies. Some message subtypes (`channel_join`,
`channel_leave`) cannot be threaded at all, returning `thread_not_found`.

Source: https://docs.slack.dev/reference/methods/conversations.replies

Shape: a two-level tree of depth one. Channel to root to replies. No deeper
nesting, no branching inside a thread.

### 2.2 Discord: threads are sub-channels, one level deep

In Discord a thread is a channel, not a message relation. A thread reuses the
channel fields (`id`, `guild_id`, `type`, `name`) and its `parent_id` holds "the
id of the `GUILD_TEXT` or `GUILD_ANNOUNCEMENT` channel the thread was created
in". Thread channel types are `PUBLIC_THREAD`, `GUILD_PRIVATE_THREAD` and
`ANNOUNCEMENT_THREAD`, plus threads-as-posts inside `GUILD_FORUM` and
`GUILD_MEDIA` channels. A public thread started from a message shares the same
`id` as that originating message. Lifecycle lives in a `thread_metadata` object
(`archived`, `archive_timestamp`, `auto_archive_duration`, `locked`): threads
auto-archive after inactivity. Counters (`message_count`, `member_count`) stop
at 50 for older threads. Posting requires `SEND_MESSAGES_IN_THREADS`.

Crucially the docs describe threads only as sub-channels created inside text,
announcement, forum or media channels. There is no mechanism to nest a thread
inside another thread. So Discord, like Slack, is one level of depth.

Source: https://docs.discord.com/developers/topics/threads

### 2.3 Matrix: an event graph with typed relations, threads still cannot nest

Matrix is the most graph-like of the four. Rooms are an ordered set of events
and events reference each other through `m.relates_to`. Threading (MSC3440) adds
a relation `rel_type: "m.thread"` whose `event_id` points at the thread root:

```json
"m.relates_to": { "rel_type": "m.thread", "event_id": "$thread_root" }
```

The server bundles a thread summary onto the root under
`unsigned.m.relations.m.thread` with three fields: `latest_event` (the most
recent event topologically that relates to the root with `rel_type` of
`m.thread`), `count` and `current_user_participated`. Genuine in-thread replies
keep the older reply mechanism, `m.in_reply_to`, alongside the thread relation,
with an `is_falling_back` flag: `false` marks a real reply to a specific event,
`true` marks a compatibility fallback that renders the thread as a reply chain
for thread-unaware clients.

Two limits matter for agents. First, threads cannot nest. The MSC states plainly
that it "does not include support for nested threads" and that "a `m.thread`
event can only reference events that do not have a `rel_type`", so a thread root
must itself be relation-free. You get a graph of relations but a thread is still
one level deep off the main timeline. Second, read receipts and read markers
"assume a single chronological timeline", which threading breaks, so receipt and
unread handling across threads is a known rough edge.

Source: https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3440-threading-via-relations.md

### 2.4 Zulip: two-level channel plus topic, no first message is special

Zulip drops per-message reply chains entirely. Every message lives in a channel
(historically "stream") and carries a topic, a short subject-like label. All
messages sharing a topic in a channel are the conversation. The docs are
explicit that "there's nothing special about the first message in a thread.
Instead, each thread is labeled with a topic" and topics can be renamed or
moved after the fact. Threads render inline in the main message view, not in a
sidebar, which lets a topic stay open for hours or days.

This is the cleanest model for parallel human conversations, because dozens of
topics coexist in one channel and a reader catches up topic by topic. But it is
still exactly two levels (channel then topic) and a topic is a flat list. A
topic cannot branch and there is no parent-child link between messages inside
it.

Sources: https://zulip.com/help/introduction-to-topics and
https://docs.zulip.com/why-zulip/

### 2.5 Summary table

| Model | Structure | Max depth | Branching within a thread | Parent link |
| --- | --- | --- | --- | --- |
| Slack | root plus flat replies | 1 | no | `thread_ts` equals parent `ts` |
| Discord | thread is a sub-channel | 1 | no | `parent_id` of the channel |
| Matrix | event graph, typed relations | 1 (threads do not nest) | no (nesting rejected) | `m.relates_to.event_id` |
| Zulip | channel plus topic | 2 fixed | no | topic label only, no per-message parent |

The headline: all four cap conversation structure at one or two fixed levels and
none supports branching inside a thread or a per-message parent that would let a
turn fork. That is the exact shape an agent run needs.

## 3. Why each model fails for AGENT conversations

The failures are not cosmetic. Each maps to a concrete agent behavior that has
no home in the model.

### 3.1 Branching tool calls

A single agent turn often issues several tool calls at once (read three files,
hit two APIs), each with its own result and the agent's next reasoning step
depends on all of them. This is a fan-out from one node to N children that then
fan back in.

- Slack and Discord: depth is one, so the tool calls and their results can only
  be posted as sibling messages in the same flat list. Nothing encodes that
  call B and result B belong together or that all of them branch off one turn.
  You lose the call-to-result pairing and the branch grouping.
- Matrix: relations can express "result B replies to call B", but because
  `m.thread` roots must be relation-free and threads do not nest, you cannot
  represent a tool call that is itself inside a thread and also has its own
  child result thread. The graph is expressive at one hop and flattens after.
- Zulip: a topic is a flat list. Branching does not exist, so parallel tool
  calls are just adjacent messages with no structural link.

### 3.2 Several agents working in parallel

Put three agents in a room working different parts of a task. In Slack, Discord
and Zulip their messages interleave in one ordered list keyed by timestamp.
Reconstructing "what did agent 2 do, in order, ignoring the others" means
filtering by author across an interleaved log. There is no native notion of
concurrent independent tracks that share a parent goal. Zulip's topics come
closest, but a human has to name and pick the topic. Agents need the branch
created and linked automatically at fan-out, not labeled by hand.

### 3.3 Sub-agent spawning

When an agent spawns a sub-agent, the sub-agent runs its own multi-step
conversation (its own tool calls, its own results) that logically hangs under a
single node in the parent: the spawn point. That is nesting to arbitrary depth,
parent turn to sub-agent run to the sub-agent's own tool-call branches. Every
model here caps at one or two levels, so a sub-agent run cannot be a collapsible
child of the node that spawned it. The best any of them can do is a link to a
separate channel or thread (Discord) or a separate topic (Zulip), which severs
the run from its spawn point and its ordering context.

### 3.4 Long-running tasks

A tool call that takes ten minutes is not a message. It is a task with a
lifecycle. None of Slack, Discord, Matrix or Zulip has a first-class task state
on a message. The closest primitive is "edit the message repeatedly", which
conflates "this text was corrected" with "this task advanced from working to
done". A2A, an agent-to-agent protocol, shows what is actually needed: a `Task`
object with an explicit `TaskState` (`TASK_STATE_SUBMITTED`, `WORKING`,
`INPUT_REQUIRED`, `COMPLETED`, `FAILED`, `CANCELED` and more) carried in status
update events. Chat models have no equivalent.

Source: https://a2a-protocol.org/latest/specification/

### 3.5 Forkable and collapsible sub-threads

Agent work benefits from exploring a branch speculatively (try approach A on a
fork, approach B on another) then keeping one and collapsing or discarding the
rest. That needs a cheap fork operation off any node and a collapse or merge.
Slack and Discord threads are one level and cannot fork mid-thread. Matrix will
reject a thread whose root is itself a thread event, so a fork of a fork is not
expressible. Zulip can rename or move a topic but a topic is flat and there is
no parent-child fork point inside it. Collapsibility in all four is a UI feature
over a flat list, not a property of the data model.

### 3.6 The common root cause

Every one of these products models a conversation as a timeline of human text
with at most a shallow, fixed nesting bolt-on. Agent conversations are trees or
DAGs of typed events with lifecycle and provenance. Bond has to model that
shape directly instead of flattening it into a chat log.

## 4. Recommended threading data model for Bond

### 4.1 Decision: a tree backbone with typed cross-edges, so the whole graph is a DAG

Pure tree is too weak: fan-in (several parallel branches feeding one conclusion)
and agent handoff (a task moving between agents) are real edges that a tree
cannot express. Pure free-form DAG is too weak in the other direction: with no
single structural parent you lose cheap collapsing, clean ordering and an
obvious "where does this belong" answer, which is exactly the ambiguity that
makes free graphs hard to render.

Bond uses both. Every node has exactly one structural parent (`parentId`), which
gives a spanning tree over the whole room. That tree is what collapses, forks
and renders. On top of it, nodes may carry additional typed edges (`refs`) that
point at other nodes: a fan-in result that depends on three sibling branches, a
merge that folds a fork back in, a handoff that continues a task under a new
agent. Structural parent plus typed refs makes the full structure a directed
acyclic graph while keeping a tree you can always walk and collapse. This is the
lesson from Matrix (typed relations are the right primitive) fixed for the thing
Matrix forbids (depth and nesting).

### 4.2 The three container levels

- Room: the top-level space where humans and agents coexist. Analogous to a
  Slack channel or Matrix room.
- Topic: an optional Zulip-style label for a long-lived line of work inside a
  room, movable and renamable. Topics are for humans to navigate. They are not
  load-bearing for agent structure.
- Node (message): the atomic unit. Every node has a type (see section 5), a
  structural parent, an author identity and a logical position. Threads,
  branches, tool-call fans and sub-agent runs are all just regions of the node
  tree, not separate object kinds.

### 4.3 Fork points and branches

A branch is created by pointing a new node's `parentId` at any existing node and
marking it as a fork. Because any node can be a parent, a fork can happen
anywhere, at any depth. That is the capability all four incumbents lack.

- `forkKind` on a node records why the branch exists: `tool_fan` (parallel tool
  calls off one turn), `subagent` (a spawned sub-agent run), `alternative`
  (speculative A/B exploration), `reply` (an ordinary threaded reply).
- Collapsing is a pure client operation over the subtree rooted at the fork
  node, so any branch is collapsible by construction. No extra field needed.
- Merging a branch back is a node with `refs` pointing at the branch tips it
  consumes, plus its own `parentId` on the line it continues. That is fan-in.

### 4.4 Ordering

Wall-clock timestamps are not enough. Agents produce events concurrently across
branches and clients, so Bond needs a causal order, not just a time order. Use
two fields together:

- `causalParent`: the node id this event was generated after in the same logical
  stream. Usually equals `parentId` but can differ for a merge.
- `lamport`: a Lamport logical counter (integer) that increases along every
  causal edge, giving a total order consistent with causality. Ties broken by
  `(lamport, authorId, id)`. A hybrid logical clock (HLC) that packs physical
  time into the counter is a reasonable variant if human-readable ordering
  matters; that is an implementation choice, not verified against a spec here.

Within a single branch, rendering order is `lamport` ascending. Across branches,
each branch renders in its own order and the fork node fixes their relative
placement.

### 4.5 Field set for a node

```ts
interface BondNode {
  id: string;              // stable unique id, content-addressed or ULID
  roomId: string;
  topicId?: string;        // optional Zulip-style label
  parentId: string | null; // structural parent; null only for the room root
  causalParent?: string;   // node this was generated after, if not parentId
  refs?: NodeRef[];         // typed non-tree edges (fan-in, merge, handoff)
  forkKind?: "tool_fan" | "subagent" | "alternative" | "reply";
  lamport: number;         // logical clock for causal total order
  createdAt: string;       // ISO 8601 wall clock, for display only
  author: Identity;        // who produced this (see section 6 on identity)
  type: MessageType;       // discriminant for the payloads in section 5
  payload: unknown;        // typed by `type`
  collapsedByDefault?: boolean; // hint: subagent runs default collapsed
}

interface NodeRef {
  kind: "depends_on" | "merges" | "handoff" | "reply_to" | "attests";
  target: string;          // id of the referenced node
}
```

`parentId` plus `lamport` give the collapsible ordered tree. `refs` give the DAG
edges agents actually need. `forkKind` and `collapsedByDefault` drive rendering.
Everything an agent run produces is one `BondNode` with a `type` and a `payload`,
which is the subject of the next section.

## 5. Agent-native message types Bond treats as first-class

Each type is a `payload` variant on `BondNode`, discriminated by `type`. Shapes
are TypeScript-ish and illustrative. Where a field mirrors a real protocol the
source is named so the shape can be checked against it.

Shared discriminant:

```ts
type MessageType =
  | "text" | "tool_call" | "tool_result" | "token_delta"
  | "receipt" | "card" | "handoff" | "status";
```

### 5.1 text

Ordinary prose from a human or an agent. The one type the incumbents already do
well. Kept minimal.

```ts
interface TextPayload {
  type: "text";
  body: string;               // markdown allowed
  mentions?: string[];        // ids of humans or agents referenced
}
```

### 5.2 tool_call

A request to invoke a tool. Mirrors MCP `tools/call` params (`name`,
`arguments`) and adds a client-side `callId` so the matching result can be
paired even when several calls fan out from one turn.

```ts
interface ToolCallPayload {
  type: "tool_call";
  callId: string;             // pairs with tool_result.callId
  name: string;               // MCP tool name
  arguments: Record<string, unknown>; // MCP `arguments`
  inputSchemaRef?: string;    // optional pointer to the tool's inputSchema
}
```

Source for the call shape: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

### 5.3 tool_result

The outcome of a `tool_call`. Follows the MCP `CallToolResult`: a `content`
array of typed parts (`text`, `image`, `audio`, `resource_link`, embedded
`resource`), an `isError` flag for tool-execution errors (distinct from
transport errors) and an optional `structuredContent` object validated against
the tool's `outputSchema`.

```ts
interface ToolResultPayload {
  type: "tool_result";
  callId: string;             // must match a tool_call.callId
  content: ContentPart[];     // MCP unstructured content
  structuredContent?: Record<string, unknown>; // MCP structured result
  isError?: boolean;          // MCP tool-execution error flag
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } };
```

The `callId` link is the structural fix for section 3.1: it pairs a result with
its call even inside a wide fan-out, which Slack and Discord cannot express.

Source: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

### 5.4 token_delta (streaming)

Streaming is a native state, not repeated edits. A model response opens a node
in a streaming state, then emits ordered deltas that append to it, then closes.
This mirrors SSE chat streaming, where each event carries an incremental
`choices[].delta.content` chunk and deltas are appended in order until a final
done marker. Bond attaches the deltas to the target node id and orders them by
`seq`.

```ts
interface TokenDeltaPayload {
  type: "token_delta";
  targetId: string;           // the node being streamed into
  seq: number;                // append order, gap-free per target
  delta: string;              // incremental text (or a tool-arg fragment)
  channel?: "text" | "reasoning" | "tool_args"; // what is streaming
  done?: boolean;             // final chunk; carries no new delta
}
```

Source for the delta stream shape:
https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events

### 5.5 receipt / attestation

A signed statement that a specific node (or set of nodes) was produced by a
specific identity and not altered. This is Bond's provenance primitive. The
signing model follows the pattern already used in the FLOP ecosystem in this
workspace: an Ed25519 key expressed as a `did:key`, a signature over a canonical
byte serialization of the payload, plus the recipe a verifier needs to rebuild
the digest. No external spec defines a "receipt message type", so the shape
below is Bond's own design grounded in that signing pattern, not a quote from a
standard.

```ts
interface ReceiptPayload {
  type: "receipt";
  subjectIds: string[];       // node ids this receipt attests to
  signer: string;             // did:key of the signing identity
  alg: "ed25519";             // signature algorithm
  canonicalization: string;   // named recipe to rebuild the signed bytes
  digest: string;             // hash of the canonical bytes, hex
  signature: string;          // base64 signature over the digest
}
```

Verification is signer-side and offline: decode the `did:key` to a raw public
key, rebuild the canonical bytes by the named recipe, check the signature with
no private key in the loop and confirm the digest matches. A tampered subject
must fail. This is the same discipline the workspace already applies to signed
artifacts.

### 5.6 card (structured card)

A machine-authored structured object meant to render as a rich card: a table, a
form, a plan, a diff, a chart spec. Grounded in MCP `structuredContent` and A2A
`DataPart` (a structured JSON blob part). The card carries the data plus a
`schemaRef` so the renderer and downstream agents can validate and reuse it.

```ts
interface CardPayload {
  type: "card";
  variant: string;            // e.g. "plan" | "table" | "form" | "diff"
  data: Record<string, unknown>; // the structured content
  schemaRef?: string;         // JSON Schema id the data conforms to
  fallbackText?: string;      // human-readable degrade path
}
```

Note: the A2A `DataPart` concept (a structured data part alongside text and file
parts) is confirmed in the A2A spec, but the exact JSON field name for its data
member could not be verified from the section excerpt read, so it is not quoted
as fact here.

Sources: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
and https://a2a-protocol.org/latest/specification/

### 5.7 handoff (agent handoff)

One agent passes a task, with enough context to continue it, to another agent.
Two primary sources shape this. A2A carries task continuity through `contextId`,
`taskId` and `referenceTaskIds` on its `Message` object, so a receiver can tie
new work to prior tasks. The Agent Handoff Protocol (AHP) defines the payload of
a transfer as five things: an `Objective` (a stand-alone description of what the
receiver should do), a `Conversation` (a chronological sample of messages,
carried as MCP sampling messages), `Resources` (user-approved files or records,
inline or remote, each with a `blob` and a `text` representation), a stable
`Thread ID` (reused when a task moves back and forth) and an `Idempotency key`
(one per logical transfer, reused only on retry). AHP explicitly transfers no
tools or privileges: the receiver decides how to do the work.

```ts
interface HandoffPayload {
  type: "handoff";
  fromAgent: string;          // identity handing off
  toAgent: string;            // identity receiving
  objective: string;          // AHP Objective
  contextId: string;          // A2A context grouping; AHP stable Thread ID
  referenceTaskIds?: string[];// A2A referenced tasks for context
  conversation: unknown[];    // AHP conversation sample (MCP sampling messages)
  resources?: { uri?: string; blob?: string; text?: string }[]; // AHP resources
  idempotencyKey: string;     // AHP idempotency key
}
```

In the node graph a handoff is also a `NodeRef` of kind `handoff`, so the task's
continuation is linked at the exact node where it moved, not orphaned in a new
channel.

Sources: https://a2a-protocol.org/latest/specification/ and
https://github.com/DeepJudge-Agent-Handoff-Protocol/agenthandoffprotocol

### 5.8 status / presence

Presence for agents is run state, not just online or typing. Model it on A2A's
task lifecycle, whose `TaskState` enum includes `TASK_STATE_SUBMITTED`,
`TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`,
`TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, `TASK_STATE_CANCELED` and
`TASK_STATE_REJECTED`. Bond surfaces both a coarse presence and, when a node is a
long-running task, its lifecycle state, updated in place rather than by editing a
text message.

```ts
interface StatusPayload {
  type: "status";
  taskId?: string;            // set when this tracks a long-running task
  lifecycle?:                 // mirrors A2A TaskState
    | "submitted" | "working" | "input_required" | "auth_required"
    | "completed" | "failed" | "canceled" | "rejected";
  presence?: "idle" | "thinking" | "calling_tool" | "streaming" | "blocked";
  note?: string;              // short human-readable detail
}
```

Source for the lifecycle states: https://a2a-protocol.org/latest/specification/

## 6. What is verified and what is not

Verified against primary sources (read this session):

- Slack single-level threading, `ts` and `thread_ts` semantics, `reply_count`,
  non-threadable subtypes.
- Discord threads as sub-channels, `parent_id`, thread types, `thread_metadata`,
  50-count caps, no nesting mechanism described.
- Matrix MSC3440 `m.thread` relation, bundled `latest_event` / `count` /
  `current_user_participated`, `m.in_reply_to` with `is_falling_back`, the
  explicit no-nested-threads rule and the single-timeline read-receipt caveat.
- Zulip channel plus topic model, "nothing special about the first message",
  topics movable and renamable, inline rendering.
- MCP `tools/call` params, `CallToolResult` content types, `isError`,
  `structuredContent`, `outputSchema`.
- A2A `Message` fields (`messageId`, `contextId`, `taskId`, `role`, `parts`,
  `referenceTaskIds`), the `TaskState` enum values, streaming update events.
- AHP handoff package (Objective, Conversation as MCP sampling messages,
  Resources with blob and text, Thread ID, Idempotency key) and its
  no-tool-transfer stance.
- SSE chat streaming delta shape (`choices[].delta.content`, ordered append).

Called out as unverified rather than asserted:

- The exact JSON field name of A2A's `DataPart` data member (the excerpt read
  was truncated before that field table). The concept is confirmed; the field
  name is not quoted.
- A2A `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` field tables were
  past the truncation point, so their exact fields are not quoted here.
- The hybrid logical clock variant in section 4.4 is an engineering option, not
  a claim backed by any cited spec.
- The `receipt` type shape in 5.5 is Bond's own design following the workspace
  FLOP signing pattern. No external standard defines it.

## 7. Sources

- Slack conversations.replies: https://docs.slack.dev/reference/methods/conversations.replies
- Discord threads: https://docs.discord.com/developers/topics/threads
- Matrix MSC3440 threading via relations: https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3440-threading-via-relations.md
- Zulip topics: https://zulip.com/help/introduction-to-topics
- Zulip design rationale: https://docs.zulip.com/why-zulip/
- MCP tools spec (2025-06-18): https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- A2A protocol specification: https://a2a-protocol.org/latest/specification/
- Agent Handoff Protocol: https://github.com/DeepJudge-Agent-Handoff-Protocol/agenthandoffprotocol
- OpenAI chat completions streaming events: https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events

