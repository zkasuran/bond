# Bond design document

Bond is an agentic-era messaging app for RevenueCat Shipaton 2026. Built with Expo
(Android-first, plus an Expo web build for a live URL). This document turns the six
research briefs in `research/` into concrete build decisions. It is written to be
buildable in about three weeks solo. Where a fact is not verified against a primary
source it is called out inline rather than asserted.

Source briefs this design draws on, all dated 2026-08-25:
`research/agentic-messaging-landscape.md`, `research/hermes-agent-protocol.md`,
`research/openclaw-protocol.md`, `research/revenuecat-rn-expo.md`,
`research/expo-eas-android-publish.md`, `research/shipaton-winning-patterns.md`.

Current scaffold this design targets (read from `work/bond/app`): Expo SDK 57,
`expo-router` 57, React 19.2, React Native 0.86, `react-native-reanimated` 4.5,
`web.output` currently `static` in `app.json`. Section 9 changes that to `server`.

## 1. Product one-liner and the wedge

One line: Bond is the messaging app for teams of humans and AI agents, where an agent
is a first-class member of the room with a verifiable identity, not a bot bolted onto a
human chat app.

The wedge against Telegram, WhatsApp, Slack and Discord is structural, not cosmetic.
Every one of those products models a conversation as a timeline of human text with, at
most, a shallow fixed thread bolted on. Slack threading is one level deep, a root plus a
flat list of replies parented by `thread_ts`
(https://docs.slack.dev/reference/methods/conversations.replies). Discord threads are
sub-channels, also one level, with no way to nest a thread inside a thread
(https://docs.discord.com/developers/topics/threads). Matrix models an event graph but
its own threading proposal states it "does not include support for nested threads" and a
thread root must be relation-free
(https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3440-threading-via-relations.md).
Zulip caps at channel plus topic, two fixed levels and a topic is a flat list
(https://zulip.com/help/introduction-to-topics).

That shape is fine for people typing prose. It breaks the moment participants are agents,
because an agent conversation is a branching computation: one turn fans out into parallel
tool calls, sub-agents spawn and rejoin, tasks run for minutes with a real lifecycle and
the payload is machine-readable state, not sentences. Bond wins by treating that shape as
the primary object. Four things none of the incumbents give as first-class primitives are
Bond's core: a message model where a tool call, a tool result, a token stream and a signed
receipt are distinct typed objects; a conversation that is a tree with typed cross-edges so
a turn can branch and rejoin; verifiable per-message identity and provenance; and humans
and agents in one room with roles, mention routing and handoff.

We do not out-feature Slack on Slack's terms. We own the one thing they cannot add without
rebuilding their data model: real structure for agent work, with cryptographic identity on
every message.

## 2. Threading data model

Decision: a tree backbone with typed cross-edges, so the whole room is a directed acyclic
graph. Every node has exactly one structural parent (`parentId`), which gives a spanning
tree that renders and collapses cleanly. On top of it, nodes carry typed non-tree edges
(`refs`) for the things a pure tree cannot express: fan-in where several branches feed one
result, a merge that folds a fork back, a handoff that moves a task to another agent. This
is the Matrix lesson (typed relations are the right primitive) fixed for the thing Matrix
forbids (depth and nesting).

Three container levels. A Room is the top-level space where humans and agents coexist. A
Topic is an optional Zulip-style movable label for a long-lived line of work inside a room,
for human navigation only, never load-bearing for agent structure. A Node is the atomic
message unit. Threads, branches, tool-call fans and sub-agent runs are all just regions of
the node tree, not separate object kinds.

A branch is created by pointing a new node's `parentId` at any existing node. Because any
node can be a parent, a fork happens at any depth, which is the capability all four
incumbents lack. `forkKind` records why the branch exists. Collapsing is a pure client
operation over the subtree, so every branch is collapsible by construction. Merging is a
node whose `refs` point at the branch tips it consumes.

Ordering uses a Lamport logical clock, not wall clock, because agents produce events
concurrently across branches and devices. A node's `lamport` increases along every causal
edge, giving a total order consistent with causality, ties broken by `(lamport, authorId,
id)`. Within a branch, render order is `lamport` ascending. `createdAt` is display only.

Node fields (TypeScript, the source of truth is `src/model/node.ts`):

```ts
interface BondNode {
  id: string;               // ULID, stable and sortable
  roomId: string;
  topicId?: string;         // optional Zulip-style label
  parentId: string | null;  // structural parent; null only for the room root
  causalParent?: string;    // node this was generated after, if not parentId
  refs?: NodeRef[];          // typed non-tree edges (DAG)
  forkKind?: "tool_fan" | "subagent" | "alternative" | "reply";
  lamport: number;          // logical clock for causal total order
  createdAt: string;        // ISO 8601, display only
  author: Identity;         // who produced this (section 5)
  type: MessageType;        // discriminant for the payloads in section 3
  payload: unknown;         // typed by `type`
  collapsedByDefault?: boolean; // subagent runs default collapsed
  sig?: Signature;          // optional Ed25519 signature over the node (section 5)
}

interface NodeRef {
  kind: "depends_on" | "merges" | "handoff" | "reply_to" | "attests";
  target: string;           // id of the referenced node
}
```

Nodes are immutable once written. Anything that looks like an edit (streaming, a status
change, a correction) is a new node that references the target, which is what makes sync
conflict-free (section 9). This is the concrete fix for the incumbent gaps documented in
`research/agentic-messaging-landscape.md` sections 3.1 through 3.5.

## 3. Agent-native message type system

Every node carries a `type` discriminant and a `payload` typed by it. Shapes are pinned to
real protocols where one exists, so downstream agents can rely on them.

```ts
type MessageType =
  | "text" | "tool_call" | "tool_result" | "token_delta"
  | "receipt" | "card" | "handoff" | "status";
```

- `text`: prose from a human or agent. `{ body: string; mentions?: string[] }`. Markdown
  allowed. The one type incumbents already do well, kept minimal.
- `tool_call`: a request to invoke a tool. Mirrors MCP `tools/call` params and adds a
  client `callId` so a result can be paired even inside a wide fan-out.
  `{ callId: string; name: string; arguments: Record<string, unknown> }`. Source:
  https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- `tool_result`: follows the MCP `CallToolResult`. `{ callId: string; content:
  ContentPart[]; structuredContent?: object; isError?: boolean }` where `ContentPart` is
  the MCP `text | image | audio | resource_link | resource` union. The `callId` link is the
  structural fix for parallel tool calls that Slack and Discord cannot express.
- `token_delta`: streaming as a native state, not repeated edits. A model response opens a
  node in a streaming state, then deltas append to it in order, then it closes.
  `{ targetId: string; seq: number; delta: string; channel?: "text" | "reasoning" |
  "tool_args"; done?: boolean }`. Mirrors SSE chat streaming
  (https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events).
- `receipt`: a signed attestation that a set of nodes was produced by an identity and not
  altered. Bond's provenance primitive, detailed in section 5. `{ subjectIds: string[];
  signer: string; alg: "ed25519"; canonicalization: string; digest: string; signature:
  string }`. No external standard defines this type, so it is Bond's own design following
  the Ed25519 + did:key signing pattern, called out as such rather than quoted from a spec.
- `card`: a machine-authored structured object that renders as a rich card (plan, table,
  form, diff, chart spec). Grounded in MCP `structuredContent` and A2A structured data
  parts. `{ variant: string; data: object; schemaRef?: string; fallbackText?: string }`.
- `handoff`: one agent passes a task with enough context to continue it. Combines A2A task
  continuity (`contextId`, `referenceTaskIds`) with the Agent Handoff Protocol package:
  an Objective, a Conversation sample, Resources, a stable Thread ID and an Idempotency
  key. `{ fromAgent; toAgent; objective; contextId; referenceTaskIds?; conversation;
  resources?; idempotencyKey }`. In the graph a handoff is also a `NodeRef` of kind
  `handoff`, so continuation is linked at the exact node where it moved. Sources:
  https://a2a-protocol.org/latest/specification/ and
  https://github.com/DeepJudge-Agent-Handoff-Protocol/agenthandoffprotocol
- `status`: agent run state, not just online or typing. Models A2A `TaskState`.
  `{ taskId?: string; lifecycle?: "submitted" | "working" | "input_required" |
  "auth_required" | "completed" | "failed" | "canceled" | "rejected"; presence?: "idle" |
  "thinking" | "calling_tool" | "streaming" | "blocked"; note?: string }`. Updated by
  writing a new node, never by mutating the tracked node. Source:
  https://a2a-protocol.org/latest/specification/

Unverified, carried from the landscape brief and not asserted as fact: the exact JSON field
name of A2A's structured `DataPart` member and the exact field tables of A2A's
`TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent`. The concepts are confirmed; the
precise field names must be checked against a live A2A payload before freezing the parser.

## 4. Universal agent bridge

Decision: Bond defines one adapter interface and ships four concrete adapters behind it.
The interface is built from two open standards Bond needs anyway, so a new runtime that
speaks either is supported without a Bond release: OpenAI Chat Completions with SSE
streaming for the turn transport and MCP for tools. Everything runtime-specific (OpenClaw
device pairing, Hermes bearer auth, a raw WebSocket dialect) hides behind the adapter and
never leaks into Bond's room and threading core. The core only ever sees the normalized
event stream below. This is the finding proven in `research/openclaw-protocol.md`: the
generic adapter is OpenClaw's adapter minus two optional depth features.

The one interface (`src/bridge/adapter.ts`):

```ts
interface GatewayCapabilities {
  streaming: boolean;
  tools: "mcp" | "native" | "none";
  sessions: boolean;      // server keeps per-thread history
  threading: boolean;
  multiAgent: boolean;    // more than one addressable agent target
  identity: "signed" | "token" | "none";
  transports: Array<"openai-http" | "mcp" | "websocket" | "custom">;
}

type AdapterEvent =
  | { kind: "turn_start"; runId?: string; agentId?: string }
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; id: string; name: string; args: unknown }
  | { kind: "tool_result"; id: string; result: unknown; isError?: boolean }
  | { kind: "turn_end"; runId?: string }   // one assistant turn done
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "done" };                        // whole exchange complete

interface GatewayAdapter {
  readonly id: string;
  readonly displayName: string;
  connect(config: GatewayConfig): Promise<GatewayCapabilities>;
  sendTurn(input: {
    threadId: string;
    sessionKey?: string;
    messages: ChatMessage[];
    agentTarget?: string;
    signal?: AbortSignal;
  }): AsyncIterable<AdapterEvent>;
  listTools?(): Promise<ToolSpec[]>;
  callTool?(name: string, args: unknown): Promise<ToolResult>;
  history?(sessionKey: string, opts?: { limit?: number }): Promise<ChatMessage[]>;
  disconnect(): Promise<void>;
}
```

`connect` is a live probe: it verifies reachability and auth and returns what the runtime
can actually do, so Bond lights up threading, tool badges or identity per gateway and
degrades gracefully when a feature is absent. `sendTurn` maps each Bond thread to one
gateway session via `sessionKey`, so history stays coherent. Every adapter must emit
`turn_end` per assistant turn and a single terminal `done`, because some runtimes (OpenClaw)
emit several turn boundaries inside one tool loop and Bond must not close a thread early.

The four adapters:

1. Bond own gateway. Targets Bond's own backend (section 9), which exposes the OpenAI
   `/v1/chat/completions` surface over a configured OpenAI-compatible endpoint. Capabilities:
   `{ streaming: true, tools: "mcp", sessions: true, threading: true, multiAgent: true,
   identity: "token", transports: ["openai-http","mcp"] }`. This is the default agent for a
   new user, so the aha moment works with zero setup. The in-code default base URL is neutral
   and the real endpoint, key and model live only in the server `.env`, never in the app
   bundle or a tracked file.

2. Generic OpenAI / WebSocket / MCP adapter. Any runtime exposing an OpenAI-compatible base
   URL and optionally an MCP server. `connect` calls `GET /v1/models`, `sendTurn` POSTs
   `/v1/chat/completions` with `stream: true` and parses SSE to `data: [DONE]`. This is the
   proof the contract generalizes and the path for bring-your-own gateways.

3. Hermes. Targets the Hermes OpenAI-compatible API server, specifically its run API:
   `POST /v1/runs` returns a `run_id`, then `GET /v1/runs/{run_id}/events` streams SSE
   lifecycle and tool events, bearer auth via `API_SERVER_KEY`, default base
   `http://localhost:8642`. On React Native the browser `EventSource` is absent, so use a
   fetch + ReadableStream SSE reader that can set the `Authorization` header. Map events to
   `AdapterEvent`: `run.started` -> `turn_start`, `assistant.delta`/`message.delta` ->
   `text`, `tool.started` -> `tool_call`, `tool.completed`/`tool.failed` -> `tool_result`,
   `approval.request` -> a blocking approval node answered with `POST
   /v1/runs/{id}/approval`, `run.completed` -> `turn_end`, `done` -> `done`. Parse the SSE
   `event:` line as the type and fall back to a `type`/`event` field in the JSON, because
   the Hermes envelope is not perfectly uniform. Source:
   https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py

4. OpenClaw. Path A from the research: talk to OpenClaw as an OpenAI-compatible client plus
   MCP. `baseUrl` is `http://<host>:18789/v1`, bearer auth, optional `x-openclaw-model` and
   `x-openclaw-session-key` headers to pin a Bond thread to an OpenClaw session. The
   OpenAI-HTTP surface is disabled by default, so `connect` must detect a 404 and surface an
   actionable setup error telling the operator to enable
   `gateway.http.endpoints.chatCompletions`. Sources:
   https://docs.openclaw.ai/gateway/openai-http-api and
   https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md

Trust note carried into the model: none of these runtimes cryptographically signs its
messages to Bond. The agent's authenticity rests on the bearer key plus base URL the user
configured. Bond signs inbound agent messages with the Bond user's own did:key as the
signer of record and the UI states that plainly rather than implying the runtime signed
anything (section 5).

## 5. Verifiable identity and message signing

Decision: every Bond user and every agent surface holds an Ed25519 keypair generated on
first launch, expressed as a `did:key`. Messages carry an Ed25519 signature over a
canonical serialization of the node. A receiver verifies offline with no private key in
the loop and the UI shows a badge. This is the same signing discipline the workspace uses
for FLOP artifacts, but Bond users get their OWN generated did:key. The FLOP identity is
never reused here.

Library and storage. Sign with `@noble/ed25519` (pure JS, runs on native and web
unchanged, no native module to link). The private key is stored in `expo-secure-store`
(iOS Keychain, Android Keystore) on device. On web there is no secure enclave, so the web
build stores the key in IndexedDB and the UI labels a web identity as lower-assurance
rather than pretending otherwise. Key generation, load and sign live in
`src/identity/keys.ts`.

did:key encoding. Take the 32-byte Ed25519 public key, prepend the multicodec prefix for
`ed25519-pub` (`0xed 0x01`), base58btc-encode the result and prefix `z`, giving
`did:key:z6Mk...`. This is the standard did:key form for Ed25519. Decoding for
verification reverses it to the raw public key. (The 0xed01 multicodec and z-base58btc
form are the widely used did:key convention; confirm the exact multibase table entry
against the did:key spec when wiring `keys.ts`, rather than hardcoding from memory.)

Canonicalization and signing. Serialize a fixed subset of the node (`id`, `roomId`,
`parentId`, `type`, `payload`, `author.did`, `lamport`, `createdAt`) with RFC 8785 JSON
Canonicalization Scheme so the byte string is deterministic across clients. Hash with
SHA-256, sign the hash with Ed25519, store `signature` as base64url. The `Signature` object
records the algorithm, the named canonicalization recipe and the signer did, so a verifier
can rebuild the exact bytes:

```ts
interface Signature {
  alg: "ed25519";
  signer: string;        // did:key of the signer
  canon: "jcs-v1";       // named recipe, versioned so it can evolve
  sig: string;           // base64url signature over sha256(canonical bytes)
}
interface Identity {
  did: string;           // did:key:z6Mk...
  displayName: string;
  kind: "human" | "agent";
}
```

Verification is offline and signer-side: decode the did:key to a raw public key, rebuild the
canonical bytes by the named recipe, verify the signature, confirm the hash matches. A
tampered payload must fail and the build ships a falsification test that mutates one byte
and asserts a red result. Three badge states in the UI: verified (green, signature valid),
unsigned (neutral, no signature present, the honest default for legacy or agent messages
Bond did not sign) and tampered (red, signature present but invalid). The `receipt`
message type in section 3 is the multi-node form of the same primitive: one node that
attests to a set of subject nodes.

Scope for three weeks. Signing and verification of `text` and `card` nodes end to end, the
badge and the falsification test are in scope. A full web-of-trust or key rotation is out
of scope and noted as future work, so we do not claim more than is built.

## 6. Humans and agents in one room

Roles per room: owner, admin, member, agent and guest. Roles attach to a membership record,
not to the global identity, so the same person can be an admin in one room and a guest in
another. An agent is a first-class member with its own did:key and its own membership.

Permissions matrix (enforced server-side in the own gateway, mirrored client-side for UI):

| Capability | owner | admin | member | agent | guest |
| --- | --- | --- | --- | --- | --- |
| Post text and cards | yes | yes | yes | yes | yes |
| Fork a thread | yes | yes | yes | yes | no |
| Invite or remove members | yes | yes | no | no | no |
| Connect or remove an agent bridge | yes | yes | no | no | no |
| Approve a gated agent tool call | yes | yes | yes | no | no |
| Change room settings and roles | yes | admins only for members | no | no | no |
| Delete any node | yes | yes | own only | own only | own only |

Agents never approve their own gated tool calls. A `tool_call` marked as requiring approval
posts a blocking node; a human with approve permission answers, which for the Hermes adapter
maps to `POST /v1/runs/{id}/approval`. This is the safety posture: an agent can request, a
human authorizes.

@mention routing. A mention carries the target's stable id, not just a display string, so
routing is unambiguous. Mentioning a human notifies them. Mentioning an agent is the trigger
to run it: Bond calls that agent's adapter `sendTurn` scoped to the current thread, with the
thread's recent nodes as `messages` and the thread id as `sessionKey`. The agent's reply
streams back as `token_delta` nodes parented under the mention, so the run lives exactly
where it was invoked. If several agents are mentioned in one node, each gets its own
`sendTurn` and its own branch, which is the parallel-agents case the incumbents flatten.

Handoff. When an agent finishes its part and passes work on, it writes a `handoff` node
(section 3) plus a `NodeRef` of kind `handoff` at the current node. The receiving agent (or
human) picks it up and its continuation is parented so the task's whole path is one walkable
subtree. `contextId` and `idempotencyKey` from the handoff payload prevent a retried handoff
from spawning duplicate work.

## 7. RevenueCat monetization

Packages: `react-native-purchases` and `react-native-purchases-ui`, both 10.7.2, installed
with `npx expo install`. No Expo config plugin exists for these, so nothing goes in the
`plugins` array of `app.json`; the native modules link via autolinking on an EAS build.
Expo Go cannot run real purchases, so a development build is mandatory. During development
use the RevenueCat Test Store (no store products needed) and swap to the real `goog_...`
platform key for any store build. Never ship a Test Store key. Source:
https://www.revenuecat.com/docs/getting-started/installation/expo

Entitlement: a single entitlement `pro`. App code checks `pro`, never a product id. The
paywall is the RevenueCat prebuilt Paywalls v2 surface, configured remotely in the
dashboard and presented with `RevenueCatUI.presentPaywallIfNeeded({
requiredEntitlementIdentifier: "pro" })`, so copy and layout iterate without an app release.
This is the least-code path and it is the surface the Design Award judges the paywall on.

Exactly what is free vs Bond Pro:

- Free: up to 2 rooms, 1 connected agent bridge, full threading including forks, verified
  signed identity for yourself and a monthly cap on agent runs (start at 50 runs per month).
  This is enough to reach the aha moment and keep using Bond daily. Gating the free tier this
  way follows the Karo HAMM-winning pattern: let the free tier prove the core value, gate the
  coordination and the agent capacity.
- Bond Pro (subscription, 7-day free trial): unlimited rooms, all four bridge adapters
  connected at once and multiple agents per room, unlimited agent runs, premium model routing
  through the own gateway, verification badges for a whole team space, larger context and
  history retained on sync and multi-human collaboration features. Pro gates Bond's actual
  differentiator, the agent capacity and the coordination, which is what a power user pays for.

Pricing and packaging. One Offering with three packages: annual as the default shown plan,
monthly and a lifetime option, with monthly and lifetime tucked behind a "View all plans"
link. This is the Mojo and Karo pattern that already won. Show the monthly equivalent next to
the annual price and anchor it ("less than a coffee a week"). Exact prices are a human
decision for zkasuran to set in the dashboard and are not invented here; the structure is the
decision, the numbers are set at account setup. An optional consumable "run pack" (extra agent
runs, also sold through RevenueCat) is a possible HAMM hybrid like Napkinmatic, included only
if it fits without bolting on.

Free trial. Configured as an introductory offer on the real Play product in Play Console;
RevenueCat detects and applies it and the prebuilt paywall renders the trial terms
automatically. This satisfies the Shipaton requirement that the app either offers a free trial
or ships a judge promo code. We ship the trial and keep a promo code as the fallback. Store
propagation of an added offer can take up to 24 hours, so configure it early. The Test Store
is not confirmed to simulate intro offers, so the judged build must carry the real Play offer.

Paywall placement, from RevenueCat's own conversion data. Primary paywall inside onboarding,
right after the aha moment (a room created, a message sent, an agent replies in-thread, a
signed badge shown). Greg, Rootd and Mojo data all support the early-onboarding placement and
about 82% of trial starts happen on day zero. Second placement at the value ceiling, the first
locked action: connecting a second bridge, adding a third agent or creating room 3. Both
placements, not either-or. Add one commitment screen just before the paywall ("Start building
my verified space") which the funnel data shows lifts conversion. Build and instrument
install-to-trial and trial-to-paid from day one so there are real numbers for the HAMM writeup,
and run at least one A/B test (headline or default plan) through RevenueCat so a result can be
reported. Sources: https://www.revenuecat.com/blog/growth/paywall-placement and
https://www.revenuecat.com/blog/growth/fix-onboarding-funnels/

## 8. Information architecture and screen list

Navigation is `expo-router` file-based routing (already scaffolded). Top level is a tab
group once past onboarding: Rooms, Agents, You. The router tree in `src/app`:

- `_layout.tsx` root. Configures the SDK, loads or generates the identity, gates on an
  onboarding-complete flag, mounts the theme and safe-area providers.
- `onboarding/` stack (shown once):
  - `welcome.tsx` the promise, one line, before features.
  - `questions.tsx` 2 to 4 personalization questions (who is in your rooms, which agent or
    tool you connect, solo or team). Answers tailor later copy.
  - `aha.tsx` the guided aha moment: a demo room where the user sends a message, the default
    Bond agent replies in-thread and a signed badge appears.
  - `commit.tsx` the single commitment screen.
  - `paywall.tsx` the primary paywall, presented right after commit.
- `(tabs)/_layout.tsx` the tab bar.
  - `(tabs)/index.tsx` Rooms list. Rooms with last activity, unread and agent presence dots.
  - `(tabs)/agents.tsx` Agents and bridges: connected runtimes, capability chips from
    `connect`, add-a-bridge entry.
  - `(tabs)/you.tsx` You: your did:key identity card, verification badge, Bond Pro status,
    restore purchases, Customer Center, settings.
- `room/[roomId].tsx` the room view: the node tree rendered as collapsible threads, presence
  and run-state header, composer with @mention routing.
- `room/[roomId]/thread/[nodeId].tsx` a focused branch view for a fork or a sub-agent run,
  reached by tapping a collapsed subtree.
- `bridge/connect.tsx` connect a bridge: pick adapter (Bond own, generic, Hermes, OpenClaw),
  enter base URL and key, run `connect`, show discovered capabilities.
- `room/[roomId]/settings.tsx` members, roles, agent memberships, topic management.
- `paywall.tsx` (reachable) the value-ceiling paywall for the second placement.

A "Restore purchases" button lives on You, because Apple and the RevenueCat docs require a
visible restore path and it is called only on explicit user action, never on launch.

## 9. Local data, sync and the own-gateway backend

Local store. An append-only log of `BondNode` records. Because nodes are immutable and every
change is a new node referencing a target (section 2), the log is a grow-only set: merging two
replicas is set union, ordered by `(lamport, authorId, id)`. That is effectively a CRDT with
no merge conflicts to resolve, which is why this model was chosen over mutable rows. A
`Storage` port (`src/store/storage.ts`) has two adapters: `expo-sqlite` on native and
IndexedDB (via a thin wrapper) on web, so one codebase serves Android and the web build.
Reads for a room are "select nodes where roomId, order by lamport", then the tree is built in
memory from `parentId`.

Sync. The Bond own gateway hosts a WebSocket at `/sync`. On connect a client sends its highest
seen `lamport` per room; the server streams every node above that, then pushes new nodes live.
A client that produces a node writes it locally first (optimistic, offline-capable), then
sends it; the server rebroadcasts to the room. No operational transform and no last-write-wins
races, because there is nothing mutable to race on. A dropped socket reconnects and replays
from the last `lamport`. This is the concrete Expo-friendly choice: SQLite plus a plain
WebSocket log, no heavyweight sync engine to learn in three weeks.

Own-gateway backend (`work/bond/server`). One Node service, Fastify plus `ws`, that does four
things:

1. Serves the exported static web build (`dist/`) so the whole product is one origin and one
   live URL.
2. Exposes `POST /v1/chat/completions` (OpenAI-compatible, streaming) by proxying a configured
   OpenAI-compatible endpoint. This is the surface the Bond own adapter targets, so that
   adapter is identical in shape to the generic one.
3. Hosts the `/sync` WebSocket and enforces the room permission matrix from section 6.
4. `GET /health`.

Auth posture, stated because no network service ships silently unauthenticated: every device
gets a bearer token at pairing, sent on the WebSocket upgrade and on `/v1` calls and the
server rejects a missing or bad token. Message authorship is additionally bound by the
did:key signature (section 5), so the bearer token authorizes transport while the signature
proves who wrote a node. The upstream credentials live only in the server's `.env`, never in
the app bundle and never in a tracked file.

Backend change to the scaffold: `app.json` currently sets `web.output: "static"`. The static
web export is fine for the front end and is served by the Node service. If Expo Router `+api.ts`
routes are wanted later they need `web.output: "server"`, but the decision here is to keep the
backend as the standalone Fastify service rather than API routes, because it needs a long-lived
WebSocket, which EAS Hosting on Cloudflare Workers does not cleanly provide. Deploy the service
as a container (Fly.io or a small VM). The exact host is a setup step; the design is host-neutral.

## 10. Publish plan and timeline

The build machine needs no local Android SDK. EAS Build compiles the AAB in the cloud and
manages signing, so the whole binary pipeline is automatable here. The real gate is not the
build, it is Google Play policy. A personal Play account created after 2023-11-13 must run a
closed test with at least 12 testers opted in continuously for 14 days before it can apply for
production, then production review is usually up to 7 days. Source:
https://support.google.com/googleplay/android-developer/answer/14151465

This matters because Shipaton requires the app to be publicly live and downloadable by a judge.
Closed testing and "in review" do not count (SHIPATON-BRIEF). So the critical path is: get 12
testers opted in, wait 14 continuous days, apply for production, pass review, roll out public.
From an Aug 25 start that lands mid-to-late September against the Sep 30 deadline, tight but
possible if closed testing starts within days. The Expo web build is the fast lane and the
safety net: `expo export --platform web` then deploy gives a live judge-clickable URL in a day
with no account gate and it is where the demo can point if Play approval slips.

Legend: [AUTO] runs headless here. [HUMAN] needs zkasuran (account, identity, banking, the
$25, real-device testers, Console clicks).

| Day | Date | Step | Who |
| --- | --- | --- | --- |
| 0 | Aug 25 | Create Google Play developer account, pay $25, start identity verification | [HUMAN] |
| 0 | Aug 25 | Scaffold green, write `eas.json` production profile, set `android.package` | [AUTO] |
| 0 | Aug 25 | Deploy the web build for a live URL now (`expo export --platform web`, deploy) | [AUTO] |
| 0-2 | Aug 25-27 | Build the four features: threading, message types, bridge, signing | [AUTO] |
| 1-3 | Aug 26-28 | Identity verification clears (duration unverified, plan 1 to 3 days) | [HUMAN] |
| 2 | Aug 27 | Create RevenueCat account, add app, wire Play billing, create Pro product + 7-day trial | [HUMAN] |
| 2 | Aug 27 | Create the app in Play Console, store listing, data safety, content rating | [HUMAN] |
| 2 | Aug 27 | Create Google Cloud Service Account, grant Play access, upload key to EAS | [HUMAN] |
| 3 | Aug 28 | First cloud AAB: `eas build --platform android --profile production` | [AUTO] |
| 3 | Aug 28 | Submit AAB to the closed testing track: `eas submit --platform android` | [AUTO] |
| 3-4 | Aug 28-29 | First-app review clears so the closed build goes live (up to ~7 days, often faster, unverified) | [HUMAN wait] |
| 4 | Aug 29 | Recruit 12+ testers, they opt in via the link and install on real devices | [HUMAN] |
| 4 -> 18 | Aug 29 -> Sep 12 | Keep 12+ testers opted in continuously for 14 days (the fixed floor) | [HUMAN wait] |
| 4-20 | ongoing | RevenueCat paywall + trial + entitlements, onboarding, UI polish, tests green | [AUTO] |
| ~18 | Sep 12 | Apply for production, answer the three Console sections | [HUMAN] |
| 18-25 | Sep 12-19 | Production access review, usually 7 days or less | [HUMAN wait] |
| ~25 | Sep 19-22 | Roll out to production, app publicly live | [AUTO submit, HUMAN release] |
| 25-36 | Sep 22 -> Sep 30 | Buffer: demo video, screenshots, Devpost submission, verify public store URL as a stranger | mixed |

Automatable here end to end: the AAB build, EAS-managed signing, the submit upload to any
track, the web export and deploy and the whole app and backend. Not automatable: account and
identity and banking verification, the $25, creating the app and Service Account the first
time, recruiting real testers on real devices and the Console review click-throughs. Slippage
risk is concentrated in the two review waits and in any tester dropping inside the 14-day
window, which resets that tester's clock. Start the closed test as early as possible, so the
14-day floor and the review both fit before Sep 30. If Play slips past the deadline, the live
web build is the fallback the submission points at and the closed-track Android build proves a
real installable app exists. Sources: https://docs.expo.dev/submit/android/ and
https://docs.expo.dev/eas/hosting/introduction/

## 11. Shipaton category strategy and demo video

Target two categories deliberately, Design Award and HAMM and answer only those two category
questions well. RevenueCat's own judging writeup is explicit: leave a category question blank and
you are not judged for it and do not spray across all 21. Two strong answers beat ten thin ones.
Not Grand Prize, which turns on paid growth we will not buy. Sources:
https://www.shipaton.com/blog/how-we-judge-shipaton and
https://revenuecat-shipaton-2025.devpost.com/rules

Design Award (product craft, polish, animation). Past winners won on micro-interactions, motion
and haptics that made the app "a joy to use," and on one hard craft problem solved so it feels
seamless. For Bond that is the room view: smooth thread collapse and expand, tasteful motion when
an agent joins or a message streams in, a satisfying animation and haptic when a message earns its
verified badge and a paywall built in the app's visual language. The one hard craft problem is
rendering a branching agent conversation legibly, which is exactly the thing incumbents cannot do.

HAMM (smartest use of RevenueCat to drive revenue). The submission names the monetization
strategy, the paywall and pricing and packaging and trial, any conversion or retention numbers we
can share and how RevenueCat powered it. Bond's story: gate the agent capacity and the
coordination, which is the genuine value ceiling, not a random feature. Give the pricing a
one-line story (Pro unlocks your whole team of agents in one verified space). Report the A/B test
result and the install-to-trial and trial-to-paid numbers RevenueCat captured. Where Design and
HAMM reinforce each other is the paywall itself: a beautifully designed, animated, on-brand paywall
placed right after the aha moment scores for craft and drives the conversion HAMM rewards.

Video beat sheet. Hard cap 3 minutes, but screeners are only guaranteed to watch the first 2, so
treat 0:00 to 2:00 as the whole pitch and keep it under 2 minutes. Everything shown must be real
and match the shipped app, because a dev advocate downloads finalists.

- 0:00-0:15 Elevator pitch in one sentence over the app on screen. Say the name Bond and who it is
  for.
- 0:15-0:45 The aha moment as a real screen recording: create a room, send a message, an agent
  replies in-thread, a message shows its verified signed badge. Real device, not slides.
- 0:45-1:15 Craft beat for the Design Award: linger on thread collapse, the motion when an agent
  joins, the branching thread UI, haptics.
- 1:15-1:45 Monetization beat for HAMM: show the paywall in context after the aha moment, name the
  free vs Pro split in one line, say the pricing story, mention it is powered by RevenueCat.
- 1:45-2:00 Proof and close: any real numbers, the live store URL on screen as text, a clean
  sign-off.
- Name the two target categories once in the video and again in the Devpost description. Use only
  licensed or original music. Post the video public.

Per house rules the video gets its own unique theme and a unique thumbnail, built with the
`work/calle-video` kit, offered once at submit stage and built on yes. The demo must carry at least
one scene of the live deployed URL and one scene of the source or build and every on-screen claim
must be real.

## Verification and scope

Buildable in three weeks solo means some things are explicitly deferred and this document does not
claim them as built: web-of-trust and key rotation (section 5), the OpenClaw raw-WebSocket depth
path and the Bond-as-OpenClaw-channel inbound path (section 4, path A only is in scope) and a
consumable run-pack layer (section 7, optional). Green-before-submit still holds: the app must pass
its own TypeScript typecheck, `expo lint` and the model and signing unit tests, including the
signature falsification test, before submission. Anything unverified in the research (the A2A
DataPart field name, the exact did:key multibase entry, EAS Hosting hostname format, Play review
durations) is confirmed against the primary source at the moment it is wired, not assumed here.

## Sources

- Agentic messaging landscape and the incumbent threading limits: `research/agentic-messaging-landscape.md`
- Hermes run API and SSE events: https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py
- OpenClaw OpenAI-compatible surface and architecture: https://docs.openclaw.ai/gateway/openai-http-api and https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md
- MCP tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- A2A protocol: https://a2a-protocol.org/latest/specification/
- Agent Handoff Protocol: https://github.com/DeepJudge-Agent-Handoff-Protocol/agenthandoffprotocol
- RevenueCat Expo install and paywalls: https://www.revenuecat.com/docs/getting-started/installation/expo and https://www.revenuecat.com/docs/tools/paywalls/displaying-paywalls
- RevenueCat conversion data: https://www.revenuecat.com/blog/growth/paywall-placement and https://www.revenuecat.com/blog/growth/fix-onboarding-funnels/
- Expo EAS build, submit and hosting: https://docs.expo.dev/build/introduction/ , https://docs.expo.dev/submit/android/ , https://docs.expo.dev/eas/hosting/introduction/
- Google Play new-account testing gate: https://support.google.com/googleplay/android-developer/answer/14151465
- Shipaton judging and rules: https://www.shipaton.com/blog/how-we-judge-shipaton and https://revenuecat-shipaton-2025.devpost.com/rules










