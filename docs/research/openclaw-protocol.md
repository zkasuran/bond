# OpenClaw protocol and the generic Bond gateway adapter

Research date 2026-08-25. Author zkasuran, drafted with AI assistance. Every
architectural claim below is pinned to a primary source (the OpenClaw repo, the
OpenClaw docs site or the published client). Where a fact could not be verified
from a primary source it is marked UNVERIFIED rather than guessed.

## What this doc decides

Bond does not build one bespoke integration per gateway. It defines ONE adapter
interface and ships concrete adapters behind it. OpenClaw turns out to expose two
standard surfaces Bond can target without any OpenClaw-specific glue: an
OpenAI-compatible `/v1/chat/completions` endpoint with SSE streaming plus MCP
(OpenClaw is both an MCP server and an MCP client registry). That is the whole
basis for the generic contract: the transport is OpenAI chat completions plus
MCP, so any runtime that speaks those two is a drop-in adapter. OpenClaw and
Hermes are just two instances of it. A deeper, OpenClaw-native path also exists
(register Bond as a first-class channel plugin or drive the raw Gateway
WebSocket) and is documented here as the high-fidelity option.

## 1. What OpenClaw is (verified)

OpenClaw is a self-hosted, MIT-licensed gateway that connects chat apps and
"channel surfaces" to AI agents, built by the OpenClaw Foundation. One
long-lived Gateway process owns every messaging surface. The docs list built-in
and plugin channels including Discord, Google Chat, iMessage, Matrix, Microsoft
Teams, Signal, Slack, Telegram, WhatsApp, Zalo, plus WebChat, with more via
external channel plugins. Runtime is Node (Node 26 recommended, 22.22.3+/24.15+/
25.9+ supported). Config lives at `~/.openclaw/openclaw.json`.

Sources: https://github.com/openclaw/openclaw/blob/main/docs/index.md and
https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md and
https://docs.openclaw.ai/

Component map (from the architecture doc):
- Gateway (daemon). Holds provider/channel connections, exposes a typed WS API,
  validates frames against JSON Schema, emits events (`agent`, `chat`,
  `presence`, `health`, `heartbeat`, `cron`). One Gateway per host.
- Clients (macOS app, CLI, web UI, automations). One WS connection each. Send
  requests like `health`, `status`, `send`, `agent`, `system-presence`.
  Subscribe to events like `tick`, `agent`, `presence`, `shutdown`.
- Nodes (macOS/iOS/Android/headless). Connect to the same WS server with
  `role: node`, declaring caps/commands (`camera.*`, `screen.record`,
  `location.get`; macOS adds `canvas.*`).
- WebChat. Static UI over the same WS API.

The Gateway HTTP server shares the WebSocket port (default `127.0.0.1:18789`),
multiplexing WS and HTTP. Hosted widget surfaces sit at `/__openclaw__/canvas/`
and `/__openclaw__/a2ui/`. Liveness `/healthz`, readiness `/readyz`.

Source: https://github.com/openclaw/openclaw/blob/main/docs/cli/gateway.md

## 2. The Gateway WebSocket protocol (verified from the architecture doc)

Transport is WebSocket text frames carrying JSON. Protocol is versioned; the
current line is `v3` (the published Node client `openclaw-node` 0.1.x/0.2.x
targets Gateway Protocol `v3`).

Envelope shapes:
- Request: `{ type: "req", id, method, params }`
- Response: `{ type: "res", id, ok, payload | error }`
- Event: `{ type: "event", event, payload, seq?, stateVersion? }`

Rules that bite:
- The FIRST frame on a connection must be `connect`. A non-`connect` first frame
  is hard-closed.
- Side-effecting methods (`send`, `agent`) require idempotency keys backed by a
  short-lived dedupe cache.
- Events are NOT replayed. On a detected gap (via `seq`/`stateVersion`) the
  client must refresh state, not expect backfill.

Connection lifecycle: client sends `req:connect`, Gateway replies `res (ok)` with
a `hello-ok` snapshot of presence + health, then pushes `event:presence` and
`event:tick`. An agent run returns an ack (`status: "accepted"`) with a `runId`,
streams `event:agent` frames, then sends a final `res:agent`.

Schemas are defined in TypeBox, JSON Schema is generated from that and Swift
models are generated from the JSON Schema. So the frame contract is machine-
checked at the Gateway.

Source: https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md

## 3. Auth and pairing (verified)

Two things authenticate a connection: a shared secret and a device identity.

Shared-secret auth. A token or password is carried in `connect.params.auth.token`
or `connect.params.auth.password`. The token resolves from `gateway.auth.token`,
the `OPENCLAW_GATEWAY_TOKEN` env var or configured SecretRefs. Auth modes are
`none`, `token`, `password`, `trusted-proxy`. `mode: "none"` disables the shared
secret and is only safe on private ingress. Binding beyond loopback without auth
is blocked by the Gateway.

Identity modes. `gateway.auth.allowTailscale: true` (Tailscale Serve) or
`gateway.auth.mode: "trusted-proxy"` authenticate from headers set by an
identity-aware proxy.

Device identity and pairing. Every client carries a device identity. A new device
ID needs pairing approval and then receives a device token. Connects must sign the
`connect.challenge` nonce and the signature `v3` binds `platform` and
`deviceFamily`. Non-local connects always require explicit approval. Auth
capability classes seen in the CLI: `read-only`, `write-capable`, `admin-capable`,
`pairing-pending`, `connect-only`.

Sources:
https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md and
https://github.com/openclaw/openclaw/blob/main/docs/cli/gateway.md

Remote access prefers Tailscale/VPN, with an SSH tunnel alternative
(`ssh -N -L 18789:127.0.0.1:18789 user@gateway-host`), optionally TLS with
pinning.

## 4. The published Node client (what a raw WS integration actually calls)

`heypinchy/openclaw-node` is a TypeScript client for the Gateway WS protocol. It
hides the handshake, challenge-response, auth and keepalive, then exposes a high
level surface. This is the closest thing to a reference client for the raw
protocol and is the fastest raw-WS path for Bond if Bond wants a live socket
rather than the HTTP surface.

Constructor: `{ url, token?, autoReconnect = true, maxReconnectAttempts = 10 }`,
default `url` `ws://localhost:18789`. `token` must match the Gateway.

Surface:
- `client.connect()` / `client.disconnect()` / `client.isConnected`
- `client.chat(text, { sessionKey, agentId })` returns an async iterator of
  streaming chunks. `client.chatSync(text)` returns a string.
- `client.sessions.list({ limit })`, `.history(sessionKey, { limit })`,
  `.send(sessionKey, text)`
- `client.config.get()` returns `{ config, hash }`; `.patch(json, hash, {note})`;
  `.apply(json, hash)`. Patch is JSON merge patch (objects merge, null deletes,
  arrays replace).
- `client.channels.status()` returns per-channel `{ connected }`.
- `client.pairing.list(channel)` and `.pairing.approve(channel, code)` (README
  flags these as inferred from CLI behavior, may not exist on all Gateways).
- `client.request(method, params)` for raw RPC. `.on(event, cb)` for
  `connected`, `disconnected`, `error`, `event`.

Streaming chunk types (the `chunk.type` discriminant). This is the normalized
agent-event vocabulary Bond should mirror:
- `text` (partial text in `chunk.text`)
- `tool_use`
- `tool_result`
- `agent_start`
- `agent_end`
- `error` (terminal; includes provider auth/quota/rate-limit and RPC errors)
- `done` (end of ONE assistant turn; a multi-turn tool loop emits several `done`
  chunks, so `done` is not a stream terminator)

Source: https://github.com/heypinchy/openclaw-node

Note: the README documents the client API, not the raw JSON envelope for chat and
sessions. The exact wire `method` strings behind `chat`, `sessions.*` and
`config.*` are NOT published there and are UNVERIFIED. The envelope in section 2
(from the architecture doc) is the verified part.

## 5. How channels register and connect (the channel plugin contract, verified)

This is the answer to "how does a platform become a channel in OpenClaw" and it
frames what adding Bond AS a channel would take. Channels are plugins loaded
in-process by the Gateway. They are not sandboxed, so a channel plugin is trusted
code (allowlisted via `plugins.allow`, which trusts plugin ids not provenance).

Capability registration. A native plugin registers against capability types. A
channel registers with `api.registerChannel(...)`. Other capabilities exist
(`api.registerProvider`, `registerSpeechProvider`, `registerWebSearchProvider`,
`registerGatewayDiscoveryService` and so on) but a messaging platform is a
channel.

Source: https://github.com/openclaw/openclaw/blob/main/docs/plugins/architecture.md

Ownership boundary. Channels do NOT implement send/edit/react tools. Core owns one
shared `message` tool, prompt wiring, the outer session-key shape, generic
`:thread:` bookkeeping and dispatch. The plugin owns its config, security,
pairing, session grammar, outbound send, threading and optional typing heartbeat.

Construction. The recommended path is `createChatChannelPlugin<ResolvedAccount>({...})`
with a `base` from `createChannelPluginBase({...})`, both from
`openclaw/plugin-sdk/channel-core`. The guidance is to start with `id`, `config`
and `setup`, then add adapter surfaces. The entry file uses
`defineChannelPluginEntry({ id, name, description, plugin, registerCliMetadata(api),
registerFull(api) })`. CLI descriptors go in `registerCliMetadata`; runtime work
(including `api.registerGatewayMethod(...)`, which must use a plugin-specific
prefix) goes in `registerFull`. A light `defineSetupPluginEntry(...)` in
`setup-entry.ts` loads when the channel is disabled or unconfigured.

The pieces a channel plugin fills in:
- `config`: `listAccountIds()`, `resolveAccount(cfg, accountId)`,
  `inspectAccount(cfg, accountId)` returning `{ enabled, configured, tokenStatus }`.
- `setup`: `applyAccountConfig({ cfg, input })`, `validateInput`.
- `security.dm`: `{ channelKey, resolvePolicy, resolveAllowFrom, defaultPolicy }`
  for DM allowlist/scoping. Optional `security.dmRouting` with `resolveDmScope`
  and `resolveDmRoute` (returns `{ sessionKey }` or `{ kind: "isolated" }` or
  `{ kind: "core" }`).
- `pairing.text`: `{ idLabel, message, notify({ target, code }) }`, the approval
  flow for a new DM contact.
- `threading`: `{ topLevelReplyToMode: "reply" }` and session/thread grammar via
  `messaging.resolveSessionConversation(...)` (maps a raw id to base conversation
  id + optional thread id + parent candidates).
- Inbound: channel-owned. The typical pattern registers an HTTP webhook in
  `registerFull` via `api.registerHttpRoute({ path, auth: "plugin", handler })`,
  parses, dispatches and acks. Helpers live in
  `openclaw/plugin-sdk/inbound-envelope` and `.../channel-inbound`. A
  socket/stream channel can instead open its own long-lived connection in
  `registerFull` (the DingTalk plugin uses DingTalk Stream mode, no webhook).
- Outbound: declarative `outbound.attachedResults.{ channel, sendText }` returning
  `{ messageId }`, plus `outbound.base.sendMedia`. Sends return `MessageReceipt`.

Manifest. `package.json` carries an `openclaw` block:
`{ extensions: ["./index.ts"], setupEntry: "./setup-entry.ts",
channel: { id, label, blurb } }`. A separate `openclaw.plugin.json` carries
`id`, `channels`, `name`, `description`, `configSchema` and
`channelConfigs.<id>.schema`. The presence of the `channels` field is what marks a
manifest as owning a channel. Bundled plugins anchor the id to the npm name
(`@openclaw/<id>`).

Typical file layout:
`index.ts` (entry), `setup-entry.ts`, `openclaw.plugin.json`, `package.json`,
`src/channel.ts` (the `createChatChannelPlugin`), `src/client.ts`, `src/runtime.ts`.

Source: https://github.com/openclaw/openclaw/blob/main/docs/plugins/sdk-channel-plugins.md

Real external example: `soimy/openclaw-channel-dingtalk`, published as
`@soimy/dingtalk`, installed with `openclaw plugins install @soimy/dingtalk`,
config key `dingtalk` with `clientId`, `clientSecret`, `dmPolicy`, `groupPolicy`,
`messageType`, min runtime `OpenClaw 2026.3.24`. Note the source files were not
readable in this pass, only the README, so the exact SDK import lines there are
UNVERIFIED. Source: https://github.com/soimy/openclaw-channel-dingtalk

## 6. The OpenAI-compatible HTTP surface (verified, this is the easy path)

The Gateway can serve a small OpenAI-compatible surface on the same port as the
WebSocket (WS + HTTP multiplex). It is DISABLED by default.

Endpoints: `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/models/{id}`,
`POST /v1/embeddings`, `POST /v1/responses`. Base URL example
`http://127.0.0.1:18789/v1`.

Enable it:
```json5
{ gateway: { http: { endpoints: { chatCompletions: { enabled: true } } } } }
```

Auth follows the Gateway config. In `token` mode send
`Authorization: Bearer <token>` (from `gateway.auth.token` or
`OPENCLAW_GATEWAY_TOKEN`); `password` mode is the same header with the password;
`trusted-proxy` routes through an identity proxy; `none` sends no header and is
private-ingress only. A valid bearer is treated as full operator access, so the
docs say keep it on loopback/tailnet/private ingress.

The `model` field is an AGENT TARGET, not a raw provider model id:
- `openclaw` or `openclaw/default` (default agent)
- `openclaw/<agentId>` or `openclaw:<agentId>` or `agent:<agentId>` (specific
  agent)

To override the backing LLM, send header `x-openclaw-model: <provider/model>`
(for example `openai/gpt-5.4`). Shared-secret bearer callers can set it directly;
identity-bearing callers need `operator.admin`. Other routing headers:
`x-openclaw-agent-id`, `x-openclaw-session-key`, `x-openclaw-message-channel`.

Streaming: set `stream: true` to get SSE. `Content-Type: text/event-stream`, each
event is a `data: <json>` line, the stream ends with `data: [DONE]`. With
`stream_options.include_usage=true` a trailing usage chunk precedes `[DONE]`. This
is exactly the OpenAI SSE shape, so any OpenAI SDK with a custom base URL streams
against it unmodified.

Every call runs as a normal Gateway agent run (same codepath as `openclaw agent`),
so routing, permissions and config match the Gateway. That is also why the
endpoint carries operator trust.

Primary source: https://docs.openclaw.ai/gateway/openai-http-api
Corroborating walkthrough (Dedalus cookbook, sets
`gateway.http.endpoints.chatCompletions.enabled true`, runs
`openclaw gateway run --auth none`, curls the endpoint):
https://docs.dedaluslabs.ai/cookbook/openclaw

## 7. MCP surfaces (verified, this is the tool/capability path)

OpenClaw sits on both sides of MCP.

As an MCP SERVER: `openclaw mcp serve` starts a stdio MCP server that connects to a
Gateway over WebSocket and exposes the Gateway-backed conversations as MCP tools:
`conversations_list`, `conversation_get`, `messages_read`, `attachments_fetch`,
`events_poll`, `events_wait`, `messages_send`, `permissions_list_open`,
`permissions_respond`. Flags: `--url`, `--token`/`--token-file`,
`--password`/`--password-file`, `--claude-channel-mode`, `--verbose`. So an MCP
client (Claude Desktop or Bond acting as an MCP client) can read and send
OpenClaw messages and answer permission prompts through a standard MCP stdio
channel.

As an MCP CLIENT registry: `openclaw mcp add|set|configure` register third-party
MCP servers that OpenClaw agent runs can call. `add` takes stdio flags
(`--command`, `--arg`, `--env`, `--cwd`) or HTTP flags (`--url`, `--transport`,
`--header`, `--auth oauth`) and probes before saving. Transports are stdio, SSE
and `streamable-http` (falls back to `sse` if `transport` omitted). Config fields
include `connectionTimeoutMs`, `requestTimeoutMs`, `auth: "oauth"`, `sslVerify`,
`clientCert`/`clientKey`, `supportsParallelToolCalls` and
`toolFilter.include`/`exclude`.

So Bond can expose its own capabilities to OpenClaw agents by publishing an MCP
server that OpenClaw registers and Bond can consume OpenClaw by being an MCP
client of `openclaw mcp serve`. Both directions are standard MCP, no
OpenClaw-specific code.

Source: https://docs.openclaw.ai/fr/cli/mcp (English mirror at the same path
under docs.openclaw.ai). Third-party plugins that extend MCP transport exist too,
for example https://github.com/lunarpulse/openclaw-mcp-plugin and a Claude.ai
bridge https://github.com/freema/openclaw-mcp

## 8. Exactly what a "Bond to OpenClaw" adapter must implement

There are three real integration points, in increasing effort and fidelity. Bond
should ship path A first (it is the generic path and needs no OpenClaw-specific
code) and treat B and C as optional depth.

Path A. Bond talks to OpenClaw as an OpenAI-compatible client plus MCP. This is
the recommended default. The adapter must:
1. Take config `{ baseUrl, authMode, secret?, agentTarget, backingModel? }`. For
   OpenClaw, `baseUrl` is `http://<host>:18789/v1`, `authMode` is one of
   `token|password|none`, `agentTarget` defaults to `openclaw/default`.
2. Precondition check: the surface is off by default, so the adapter must detect a
   404 or disabled response and surface a clear setup error telling the operator
   to set `gateway.http.endpoints.chatCompletions.enabled true`. This is a
   configuration Bond cannot set for a remote gateway, so treat it as a
   connect-time capability probe (call `GET /v1/models`).
3. Send a turn: `POST /v1/chat/completions` with `{ model: agentTarget, messages,
   stream: true }`, header `Authorization: Bearer <secret>` when not `none` and
   optional `x-openclaw-model`, `x-openclaw-session-key`, `x-openclaw-agent-id` to
   pin Bond's thread to an OpenClaw session.
4. Parse SSE: read `data:` lines, stop on `data: [DONE]`, map OpenAI delta chunks
   into Bond's normalized event stream (text delta, tool call, finish).
5. Tools via MCP: to give the OpenClaw agent Bond-side tools, register Bond as an
   MCP server the operator adds with `openclaw mcp add`. To let Bond call OpenClaw
   conversations, connect as an MCP client to `openclaw mcp serve`.
6. State its auth posture. If `authMode` is `none` the adapter must warn (no
   secret, operator-level access on that port).

What Bond does NOT need on path A: no channel plugin, no raw WS, no OpenClaw SDK.

Path B. Bond drives the raw Gateway WebSocket (via `openclaw-node` or a
hand-rolled client). Use this only if Bond needs live presence, streaming node
capabilities, session history reads or channel status that the HTTP surface does
not give. The adapter must open `ws://host:18789`, send `connect` first with
`params.auth.token`, satisfy the device challenge (or reuse `openclaw-node` which
does the challenge-response), then use `chat({ sessionKey, agentId })` for streamed
turns and `sessions.*` for history. It must map the `chunk.type` vocabulary
(`text`, `tool_use`, `tool_result`, `agent_start`, `agent_end`, `error`, `done`)
into Bond events and must treat multiple `done` chunks as turn boundaries, not
stream end. Idempotency keys are required on `send`/`agent`.

Path C. Bond IS an OpenClaw channel (a plugin that makes Bond one of OpenClaw's 50+
surfaces). This is the inverse direction: it lets OpenClaw users reach Bond, not
Bond reach OpenClaw. Build it only if that inbound story matters. It means shipping
an npm plugin per section 5: `createChatChannelPlugin` with `config`, `setup`,
`security.dm`, `pairing.text`, `threading`, an inbound path (webhook via
`api.registerHttpRoute` or a Bond long-lived socket opened in `registerFull`) and
`outbound.attachedResults.sendText` calling Bond's own send API. Plus the two
manifests. This is real code the OpenClaw project would have to trust
(in-process, not sandboxed).

For Bond's universal-bridge goal, path A is the adapter. B and C are OpenClaw
depth that most gateways will not have equivalents of, so they stay
OpenClaw-specific extensions, not part of the generic contract.

## 9. The generic Bond gateway adapter contract

Design principle: Bond defines one interface. Every gateway is a concrete adapter.
The interface is built from two open standards Bond already needs, so a new
gateway that speaks either is supported without a new Bond release:
- Turn transport: OpenAI Chat Completions with SSE streaming.
- Tools and capabilities: MCP (both directions, client and server).

Everything gateway-specific (OpenClaw device pairing, Hermes auth, a raw WS
dialect) hides behind the adapter and never leaks into Bond's room/threading core.
Bond's core only ever sees the normalized event stream in 9.3.

### 9.1 Capability descriptor

An adapter first declares what it can do, so Bond's UI can light up threading,
tool badges or identity per gateway and degrade gracefully when a feature is
absent.

```ts
interface GatewayCapabilities {
  streaming: boolean;          // SSE or WS incremental deltas
  tools: "mcp" | "native" | "none";
  sessions: boolean;          // server keeps per-thread history
  threading: boolean;         // server models reply-to / thread ids
  multiAgent: boolean;        // more than one addressable agent target
  identity: "signed" | "token" | "none";
  transports: Array<"openai-http" | "mcp" | "websocket" | "custom">;
}
```

### 9.2 Config and identity

```ts
interface GatewayConfig {
  id: string;                 // "openclaw" | "hermes" | "bond-native" | ...
  baseUrl: string;            // e.g. http://host:18789/v1  (openai-http)
  authMode: "token" | "password" | "bearer" | "oauth" | "none";
  secret?: string;            // never logged, never in tracked files
  agentTarget?: string;       // maps to OpenAI `model` field
  backingModel?: string;      // optional per-turn model override
  mcp?: {                     // optional tool plane
    serverUrl?: string;       // Bond as MCP client of the gateway
    transport?: "stdio" | "sse" | "streamable-http";
    expose?: boolean;         // Bond publishes its own MCP server
  };
}
```

### 9.3 Normalized event stream

The contract Bond's threading engine consumes. It is deliberately the union of the
OpenClaw `chunk.type` vocabulary and the OpenAI streaming deltas, since those are
the two shapes real gateways emit, so the mapping is lossless both ways.

```ts
type AdapterEvent =
  | { kind: "turn_start"; runId?: string; agentId?: string }
  | { kind: "text"; delta: string }
  | { kind: "tool_call"; id: string; name: string; args: unknown }
  | { kind: "tool_result"; id: string; result: unknown; isError?: boolean }
  | { kind: "turn_end"; runId?: string }        // one assistant turn done
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "done" };                            // whole exchange complete
```

Mapping note that must be enforced by every adapter: some gateways (OpenClaw)
emit several turn boundaries inside one tool loop. Adapters emit `turn_end` per
assistant turn and a single terminal `done`, so Bond never closes a thread early.

### 9.4 The interface

```ts
interface GatewayAdapter {
  readonly id: string;
  readonly displayName: string;

  // Connect-time probe. Verifies reachability + auth and returns what the
  // gateway can actually do, so Bond adapts its UI instead of assuming.
  connect(config: GatewayConfig): Promise<GatewayCapabilities>;

  // Send one user turn into a Bond thread and stream the reply back as
  // normalized events. sessionKey binds a Bond thread to a gateway session.
  sendTurn(input: {
    threadId: string;
    sessionKey?: string;
    messages: ChatMessage[];
    agentTarget?: string;
    signal?: AbortSignal;
  }): AsyncIterable<AdapterEvent>;

  // Optional MCP tool plane. Present only when capabilities.tools === "mcp".
  listTools?(): Promise<ToolSpec[]>;
  callTool?(name: string, args: unknown): Promise<ToolResult>;

  // Optional history read for gateways where capabilities.sessions is true.
  history?(sessionKey: string, opts?: { limit?: number }): Promise<ChatMessage[]>;

  disconnect(): Promise<void>;
}
```

`ChatMessage` is the OpenAI shape (`{ role, content, name?, tool_calls? }`) so no
translation is needed on the wire for `openai-http` adapters. Bond's agent-native
message model wraps this with its own signed-identity envelope; the adapter only
carries the OpenAI-shaped payload.

### 9.5 The two concrete adapters over one interface

OpenClawAdapter (fully specified from this research):
- `connect` calls `GET /v1/models`, returns
  `{ streaming: true, tools: "mcp", sessions: true, threading: true,
     multiAgent: true, identity: "token", transports: ["openai-http","mcp",
     "websocket"] }`.
- `sendTurn` POSTs `/v1/chat/completions` with `stream: true`, bearer auth,
  optional `x-openclaw-model` and `x-openclaw-session-key`, parses SSE to
  `[DONE]`.
- `listTools`/`callTool` bridge to `openclaw mcp serve` (stdio) or a registered
  MCP endpoint.
- `history` optionally upgrades to raw WS via `openclaw-node` `sessions.history`.
- Setup guard: report the disabled-endpoint case as an actionable error.

HermesAdapter (SHAPE ONLY, Hermes protocol UNVERIFIED in this pass):
- Hermes is named in the Bond brief as another agent runtime. No Hermes protocol
  was researched here, so its concrete surface is not documented and must not be
  invented. The contract is designed so that IF Hermes exposes an
  OpenAI-compatible endpoint or an MCP surface, HermesAdapter is a thin config
  binding with no interface change. If Hermes speaks only a bespoke protocol, its
  adapter maps that protocol into the same `AdapterEvent` stream internally, the
  same way path B wraps OpenClaw's raw WS. Either way Bond's core is untouched.
- ACTION: research Hermes separately and fill this in. Flag as open.

BondNativeAdapter and a GenericAdapter (any OpenAI-compatible base URL, optional
MCP) round out the four adapters in the brief. The GenericAdapter is literally the
OpenClawAdapter minus the OpenClaw-specific setup guard and WS upgrade, which is
the proof the contract generalizes: OpenClaw is the generic adapter plus two
optional depth features.

## 10. Unverified points and open questions

- The raw WS `method` strings behind `chat`, `sessions.*` and `config.*` are not
  published in the `openclaw-node` README. The frame envelope in section 2 is
  verified from the architecture doc, the exact method names are not. Read
  `openclaw-node/src` if path B is built.
- The exact device challenge-response byte format (how the `connect.challenge`
  nonce is signed, key type, the `v3` signature binding) is described in prose in
  the architecture doc but not given as a concrete schema. `openclaw-node` hides
  it. Do not hand-roll the raw handshake without reading that client's source.
- The DingTalk plugin's actual SDK import lines and `index.ts` were not readable
  in this pass (README only). The channel-plugin contract in section 5 comes from
  the official SDK doc, which is authoritative, but a concrete file-level template
  should be lifted from a real plugin's `src` before writing path C.
- Hermes protocol is entirely unresearched here. Section 9.5 leaves it as a shape,
  not a spec. This is the main follow-up.
- OpenClaw version pace is fast (packages pin dates like `2026.3.24` and protocol
  `v3`). Pin the adapter to a tested Gateway version and re-check the OpenAI-HTTP
  and MCP docs at build time, since both surfaces are young.
- Some search-result summaries (Medium, HackMD, Railway, Dedalus) are secondary.
  Every load-bearing claim above is cited to a primary source (the repo or
  docs.openclaw.ai). Secondary links are corroboration only.

## 11. Sources

Primary (OpenClaw repo and docs site):
- Overview: https://github.com/openclaw/openclaw/blob/main/docs/index.md
- Architecture and WS protocol:
  https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md
- Gateway CLI, ports, auth, discovery:
  https://github.com/openclaw/openclaw/blob/main/docs/cli/gateway.md
- Plugin architecture and capability model:
  https://github.com/openclaw/openclaw/blob/main/docs/plugins/architecture.md
- Channel plugin contract:
  https://github.com/openclaw/openclaw/blob/main/docs/plugins/sdk-channel-plugins.md
- OpenAI-compatible HTTP surface:
  https://docs.openclaw.ai/gateway/openai-http-api
- MCP CLI (server + client registry):
  https://docs.openclaw.ai/fr/cli/mcp
- Gateway configuration:
  https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration.md
- Docs home: https://docs.openclaw.ai/

Published client and example plugins:
- Node WS client: https://github.com/heypinchy/openclaw-node
- DingTalk channel plugin: https://github.com/soimy/openclaw-channel-dingtalk
- MCP transport plugin: https://github.com/lunarpulse/openclaw-mcp-plugin
- Claude.ai MCP bridge: https://github.com/freema/openclaw-mcp

Corroborating (secondary):
- Dedalus cookbook (enable + curl the OpenAI endpoint):
  https://docs.dedaluslabs.ai/cookbook/openclaw
- Railway deploy template: https://railway.com/deploy/openclaw-secure
