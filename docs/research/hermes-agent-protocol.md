# Hermes Agent: protocol research for a "Bond to Hermes" adapter

Research date: 2026-08-25. Author: research pass for the Bond universal agent bridge.

All architecture claims below were read from the live source at
`github.com/NousResearch/hermes-agent` (default branch `main`, pushed 2026-08-25,
MIT licensed) and the official docs at `hermes-agent.nousresearch.com`. Where a
fact came only from a third-party blog it is marked as such. Where a fact could
not be verified it is called out explicitly.

## TL;DR for the adapter

Hermes exposes several ways in. The right one for Bond is the built-in
OpenAI-compatible API server (`gateway/platforms/api_server.py`), specifically
its proprietary run API: `POST /v1/runs` to send a message and get a `run_id`,
then `GET /v1/runs/{run_id}/events` to read a Server-Sent-Events stream of
structured lifecycle and tool events. Auth is a single bearer token
(`API_SERVER_KEY`) over HTTP. This is a real HTTP + SSE contract, not a bot
integration, so a mobile or web client can drive it directly. The second-best
option, if Bond can spawn a local subprocess, is ACP over stdio (`hermes acp`),
which is an open JSON-RPC standard but needs process control rather than a URL.

## What Hermes Agent is

Hermes Agent is Nous Research's self-hosted autonomous agent runtime. It is
mostly Python (entry files `cli.py`, `run_agent.py`, `hermes_bootstrap.py`,
`mcp_serve.py`) with a TypeScript Electron desktop app under `apps/desktop`. It
runs on the user's own machine, connects to an LLM provider the user picks
(OpenRouter, OpenAI, Anthropic or the Nous Portal tool gateway) and executes
tasks with a large built-in toolset plus a learning loop that writes skills and
persistent memory. Config lives in `~/.hermes/config.yaml`, secrets in
`~/.hermes/.env`, session state in `~/.hermes/state.db`.

Relevant top-level packages in the repo: `agent/`, `gateway/`, `acp_adapter/`,
`tui_gateway/`, `ui-tui/`, `providers/`, `tools/`, `skills/`, `cron/`,
`plugins/`, `optional-mcps/` and `apps/desktop/`.

## The five ways a client can connect (and which to use)

1. OpenAI-compatible API server over HTTP + SSE. Real code in
   `gateway/platforms/api_server.py`. Bearer-token auth. Best fit for Bond.
2. ACP (Agent Client Protocol) over stdio, via `hermes acp` and the
   `acp_adapter/` package. Open JSON-RPC standard, used by editors like Zed and
   by Buzz Desktop. Needs subprocess control, not a network URL.
3. MCP server over stdio, via `hermes mcp serve` (`mcp_serve.py`). Exposes
   messaging conversations as MCP tools. This is a channel bridge, not the agent
   chat loop, so it is the wrong altitude for Bond's main flow.
4. JSON-RPC over WebSocket to the local gateway. This is the private contract
   the Electron desktop app speaks to the runtime. Real but not documented as a
   public API.
5. Messaging-platform gateway. Telegram, Discord, Slack, WhatsApp, Signal,
   Email, Teams and Block's Buzz (Nostr). These are bot integrations with DM
   pairing, not a generic client protocol.

Recommendation: build the Bond to Hermes adapter against option 1 as the primary
transport, with option 2 (ACP) as a documented fallback for a locally launched
Hermes. Rationale below.

## Primary transport: the OpenAI-compatible API server

Source: `gateway/platforms/api_server.py` (module docstring lines 1 to 46, route
table around lines 2267 to 2272). It is an aiohttp server started by the gateway
process. Default listen address `http://localhost:8642/v1`, default port constant
`DEFAULT_PORT = 8642`, overridable by env `API_SERVER_PORT` or config key
`platforms.api_server.port`. It is a gateway platform adapter, so it comes up when
the gateway runs with `api_server` configured under `platforms.api_server`.

### Endpoints

Standard OpenAI-shaped:
- `POST /v1/chat/completions` (Chat Completions; stateless, optional session
  continuity via `X-Hermes-Session-Id` header, optional memory scope via
  `X-Hermes-Session-Key`)
- `POST /v1/responses`, `GET|DELETE /v1/responses/{id}` (Responses API, stateful
  via `previous_response_id`)
- `GET /v1/models`, `GET /v1/capabilities`
- `GET /health`, `GET /health/detailed`

Session CRUD:
- `GET|POST /api/sessions`, `GET|PATCH|DELETE /api/sessions/{id}`
- `GET /api/sessions/{id}/messages`
- `POST /api/sessions/{id}/fork`
- `POST /api/sessions/{id}/chat` and `POST /api/sessions/{id}/chat/stream`

Proprietary run API (the one Bond should use):
- `POST /v1/runs` starts a run and returns a `run_id` immediately (HTTP 202)
- `GET /v1/runs/{run_id}` polls run status
- `GET /v1/runs/{run_id}/events` streams structured lifecycle and tool events over SSE
- `POST /v1/runs/{run_id}/approval` resolves a pending tool approval
- `POST /v1/runs/{run_id}/steer` injects guidance into a running agent
- `POST /v1/runs/{run_id}/stop` interrupts a running agent

### Auth and pairing

One shared secret. The server reads `API_SERVER_KEY` (env or
`platforms.api_server.extra.key`) and refuses to start without it. Every request
must carry `Authorization: Bearer <API_SERVER_KEY>`. `_check_auth` validates the
Bearer token and returns a `gateway_auth_error` / `gateway_auth_failed` JSON error
on mismatch (lines ~1922 to 1971). There is no per-user OAuth or device pairing on
this surface: the DM-pairing code flow in `gateway/pairing.py` (8-char codes,
1-hour expiry, rate limits, `~/.hermes/pairing/`) is for the chat-platform bots,
not for the API server. So for Bond, "pairing" means the user pastes the Hermes
base URL plus the API key into Bond once, the same posture as any self-hosted key.

Security note to carry into Bond: this key is a full bearer credential to a
runtime with shell and file tools. Bond must store it in secure storage
(Keychain / Keystore), never in plaintext config and should default to HTTPS
(the server itself listens on localhost HTTP, so remote use implies a tunnel or
reverse proxy the user sets up).

### Sending a message

`POST /v1/runs` with a JSON body (parsed in `_handle_runs`, lines ~7573 onward):

```json
{
  "input": "the user message text",
  "model": "optional model/route alias",
  "session_id": "optional; groups turns into one conversation",
  "instructions": "optional ephemeral system prompt",
  "conversation_history": [{"role": "user", "content": "..."}],
  "previous_response_id": "optional; pulls history from a stored response"
}
```

`input` is required and may be a plain string or an array of message objects (the
last is treated as the new user turn, earlier ones become history). If no
`session_id` is given the server uses the generated `run_id` as the session id.
The response is HTTP 202 with an object shaped like
`{"object": "hermes.run", "run_id": "run_<hex>", "status": "queued", ...}`.

### Subscribing to events

`GET /v1/runs/{run_id}/events` returns `Content-Type: text/event-stream`
(`Cache-Control: no-cache`, `X-Accel-Buffering: no`). The handler
(`_handle_run_events`, lines ~8016 onward) will wait up to ~1s for the run to
register, then streams frames. Each frame is written by `_sse_frame` as an
optional `event: <name>` line followed by `data: <json>\n\n` (definition at line
297). A `: keepalive` comment is sent every 30s of idle and a `: stream closed`
comment plus a terminal `done` event mark the end. Every payload carries
`session_id`, `run_id`, a monotonically increasing `seq` and a `ts` epoch
timestamp (set in `_event_payload`, lines ~4800 onward).

Event names emitted on this stream (verified in source):

| Event | Meaning | Key payload fields |
| --- | --- | --- |
| `run.started` | run accepted, agent starting | `user_message`, `runtime` |
| `message.started` | assistant message opened | `message: {id, role}` |
| `message.delta` | incremental assistant text | `delta` |
| `assistant.delta` | incremental assistant text (run stream) | `message_id`, `delta` |
| `tool.started` | a tool call began | `message_id`, `tool_name`, `args`, `preview` |
| `tool.progress` | tool progress or reasoning preview | `tool_name`, `delta` |
| `tool.completed` | tool call finished ok | `message_id`, `tool_name`, `preview` |
| `tool.failed` | tool call failed | `message_id`, `tool_name`, `preview` |
| `approval.request` | a tool needs user approval | run/tool context |
| `approval.responded` | approval was resolved | `choice`, `resolved` |
| `assistant.completed` | final assistant text ready | `content`, `runtime`, `partial`, `interrupted` |
| `run.completed` | run done | `messages`, `usage`, `runtime`, optional `pending_steer` |
| `run.cancelled` | run interrupted | last-event marker |
| `run.failed` | run errored | error text |
| `error` | error payload mid-stream | `message` (redacted) |
| `done` | stream terminator | empty |

Note there is a small envelope inconsistency in the source: some events (for
example `message.delta`, `approval.responded`) are enqueued as plain dicts with an
`"event"` key, while others go through `_event_payload` as a `(name, payload)`
pair. The adapter should read the SSE `event:` line as the type when present and
fall back to a `type`/`event` field inside the JSON, rather than assuming one
shape. This is worth a defensive parser.

The session-scoped twin `POST /api/sessions/{id}/chat/stream` emits the same
event vocabulary (the same `_run_and_signal` machinery, lines ~4830 onward), so an
adapter that speaks the run stream can reuse the parser for the session stream.

### Approvals, steering, stopping

When the agent wants to run a gated tool it emits `approval.request` and blocks.
The client resolves it with `POST /v1/runs/{run_id}/approval` and body
`{"choice": "once" | "session" | "always" | "deny", "all": false}` (aliases
`approve`/`allow` map to `once`). The server then emits `approval.responded` and
resumes. `POST /v1/runs/{run_id}/steer` injects a mid-run instruction and returns
`{"object": "hermes.run.steer", "accepted": true}`. `POST /v1/runs/{run_id}/stop`
interrupts. Approval scope is per `run_id`, so resolving one run never unblocks
another.

## Fallback transport: ACP over stdio

Source: `acp_adapter/` (`server.py`, `session.py`, `events.py`, `auth.py`,
`entry.py`, `tools.py`, `permissions.py`). Launched by `hermes acp`,
`hermes-acp` or `python -m acp_adapter.entry`. It implements the Agent Client
Protocol, which is JSON-RPC 2.0 over stdio (stdout is reserved for JSON-RPC
frames, stderr for logs and unknown methods return the JSON-RPC `-32601`
error). It depends on the `acp` / `agent-client-protocol` package and its
`acp.schema` types. ACP is the open standard Zed uses for editor-to-agent
integration.

Handshake and methods seen in `server.py` imports and handlers:
- `initialize` → `InitializeResponse` with `AgentCapabilities`,
  `PromptCapabilities`, `SessionCapabilities`, model list
- `authenticate` → `AuthenticateResponse`. Auth methods are advertised by
  `acp_adapter/auth.py`: a `TerminalAuthMethod` (id `hermes-setup`) to open
  provider setup, plus an `AuthMethodAgent` for the resolved runtime provider
  when credentials already exist
- `new_session`, `load_session`, `resume_session`, `fork_session`,
  `list_sessions` → sessions persist to `~/.hermes/state.db`
- `prompt` → `PromptResponse`. Content blocks: `TextContentBlock`,
  `ImageContentBlock`, `AudioContentBlock`, `EmbeddedResourceContentBlock`,
  `ResourceContentBlock`
- `set_session_model`, `set_session_mode`, `set_session_config_option`
- `cancel`

Streaming is via `session_update` notifications pushed from the agent
(`acp_adapter/events.py`): `AgentMessageChunk` (assistant text),
`AgentThoughtChunk` (reasoning), `UserMessageChunk`, tool-call start/complete
blocks (`acp_adapter/tools.py`), `AgentPlanUpdate` (todo/plan panel),
`AvailableCommandsUpdate`, `UsageUpdate`, `SessionInfoUpdate`. MCP servers can be
attached per session via `McpServerStdio` / `McpServerHttp` / `McpServerSse`.

When to use ACP over the API server: only if Bond runs on the same host as
Hermes and can spawn and supervise a subprocess and speak stdio JSON-RPC. On
Android or a web build that is impractical, which is why the HTTP API server is
the primary choice for Bond.

## The other three surfaces (brief)

MCP server (`hermes mcp serve`, `mcp_serve.py`): a stdio MCP server exposing the
messaging layer as tools (`conversations_list`, `conversation_get`,
`messages_read`, `attachments_fetch`, `events_poll`, `events_wait`,
`messages_send`, `permissions_list_open`, `permissions_respond`, plus
`channels_list`). It bridges the platform conversations, it does not drive the
agent turn loop, so it is not the right surface for Bond's core send-and-stream.

WebSocket JSON-RPC gateway: the Electron desktop app talks to the runtime over a
JSON-RPC channel with an event stream (`apps/desktop/src/lib/gateway-rpc.ts`,
`gateway-ws-url.ts` and the `gateway-event/` handlers `message-stream.ts`,
`tools.ts`, `lifecycle.ts`, `status.ts`, `session-info.ts`, `input-requests.ts`).
The event families there mirror the SSE ones. This is a private app-to-runtime
contract with no documented public schema, so relying on it is riskier than the
API server. There is also a local `gateway/control_socket.py` (Unix domain
socket or Windows named pipe, single-request JSON verbs `identify`/`status`,
never a TCP port) that is purely for local process coordination.

Messaging platforms including Buzz: `hermes gateway setup` connects bots on
Telegram, Discord, Slack, WhatsApp, Signal, Email, Teams and Block's Buzz. Per a
July 2026 MarkTechPost writeup (third-party, not repo-verified), the Buzz path
uses a NIP-42-authenticated Nostr WebSocket with BIP-340 signing and a
`transport` setting of `auto` / `websocket` / `poll`, where every participant is a
Nostr keypair rather than a bot token. This is interesting for Bond's own
identity story but it is a platform bot integration, not a generic client API.

## What a "Bond to Hermes" adapter must implement

Target the HTTP + SSE run API. Against Bond's universal bridge interface (one
adapter interface, per the Shipaton brief), the Hermes adapter needs these
capabilities.

### Config and connect

- Inputs: `baseUrl` (default `http://localhost:8642`, user-editable so a tunnel
  or LAN address works), `apiKey` (the `API_SERVER_KEY`). Store the key in secure
  device storage, not in app config.
- Health probe on connect: `GET /health` (or `GET /v1/capabilities` to discover
  which endpoints and features this Hermes build supports; the capabilities map
  advertises the runs routes). Treat a 401/`gateway_auth_failed` as a bad key and
  a 404 on `/v1/runs` as an older backend that lacks the run API.
- Optionally `GET /v1/models` to populate a model picker.

### Auth

- Attach `Authorization: Bearer <apiKey>` to every request. No token refresh, no
  OAuth handshake on this surface. There is no separate pairing step, so Bond's
  "connect an agent" screen is a base-URL + key form plus a health check.

### Send a message

- `POST /v1/runs` with `{ "input": <text>, "session_id": <bondThreadId>, optional
  "model", "instructions", "conversation_history" }`. Map one Bond thread to one
  Hermes `session_id` so history and memory stay coherent across turns.
- Keep the returned `run_id`. It is the handle for the event stream and for
  approval / steer / stop.

### Subscribe to events

- Open `GET /v1/runs/{run_id}/events` and read the SSE stream. On React Native
  the browser `EventSource` is not built in, so use a fetch-stream SSE client
  (for example `react-native-sse` or a fetch + ReadableStream reader) that can
  send the `Authorization` header. Parse each frame's `event:` name and `data:`
  JSON, tolerate `: keepalive` and `: stream closed` comments and stop on `done`
  / `run.completed` / `run.failed` / `run.cancelled`.
- Coalesce `assistant.delta` / `message.delta` into the streaming Bond message
  body. Reset the reconnect logic per run: if the socket drops mid-run, Bond can
  fall back to `GET /v1/runs/{run_id}` polling for terminal status, since deltas
  are not replayable after disconnect.

### Interactive control

- On `approval.request`, surface a Bond approval prompt and answer with
  `POST /v1/runs/{run_id}/approval` `{ "choice": "once|session|always|deny" }`.
- Expose stop as `POST /v1/runs/{run_id}/stop` and (optionally) steer as
  `POST /v1/runs/{run_id}/steer` `{ "input": <text> }` while a run is live.

### Map Hermes events to Bond message types

Bond's own message model is not yet frozen (its `DESIGN.md` is still being
produced and no message-type source file exists in `work/bond` as of this
research), so the target types below are the reasonable canonical set implied by
the brief (agent-native messages, threading, tool visibility, signed identity).
Confirm the exact names against `DESIGN.md` when it lands and adjust the right
column only.

| Hermes event | Bond message type / action |
| --- | --- |
| `run.started` | open a new agent turn in the thread; status = running |
| `message.started` | create the assistant message placeholder (streaming) |
| `assistant.delta` / `message.delta` | append to the streaming assistant text body |
| `tool.started` | a `tool_call` block on the message, status running, with `tool_name` + `args` |
| `tool.progress` | update the tool block or a `reasoning`/thinking block when `tool_name` is `_thinking` |
| `tool.completed` | tool block status complete, attach result preview |
| `tool.failed` | tool block status failed, attach error |
| `approval.request` | an interactive `approval_request` message that blocks the turn until the user answers |
| `approval.responded` | resolve the approval UI, resume status = running |
| `assistant.completed` | finalize the assistant message body; mark not-partial |
| `run.completed` | close the turn; attach `usage`; status = done; optional `pending_steer` becomes the next user turn |
| `run.cancelled` | close the turn as interrupted |
| `run.failed` / `error` | attach an error to the turn; status = failed |
| `done` | end of stream; tear down the SSE reader |

Bond identity note: Hermes messages on this transport are not cryptographically
signed by Hermes. Bond's verifiable-identity feature signs messages with the
Bond user's own `did:key`. So the Bond adapter is the signer of record for the
agent's inbound messages inside a Bond room. The agent's authenticity to Bond
rests on the bearer key plus the base URL the user configured, which is worth
stating plainly in Bond's trust model rather than implying Hermes signed anything.

## Known vs assumed

Verified from the live repo source (primary):
- The OpenAI-compatible API server exists, its full route table, the `/v1/runs`
  request body, the SSE event names and envelope, the bearer-token auth via
  `API_SERVER_KEY`, the default port 8642 and the approval / steer / stop flow.
  Read directly from `gateway/platforms/api_server.py`.
- The ACP adapter exists, its JSON-RPC-over-stdio nature, its method set and
  `session_update` notification types. Read from `acp_adapter/`.
- The MCP server, its tool list and its stdio launch. Read from `mcp_serve.py`.
- The messaging-gateway command surface and the DM pairing design. Read from the
  docs site and `gateway/pairing.py`.

Assumed or not fully verified:
- The exact JSON payload of some SSE events beyond the field names quoted here.
  The envelope is not perfectly uniform in the source (some events are plain
  dicts, some are `_event_payload` pairs), so the adapter should parse
  defensively rather than to a fixed schema. Confirm against a live run before
  freezing Bond's parser.
- Whether `platforms.api_server` is enabled by default in a fresh install or
  needs explicit config. The code shows it as a gateway platform adapter that
  requires `API_SERVER_KEY` to start, so assume the user must set the key and
  enable the platform. Verify with `hermes gateway setup` on a real install.
- The Buzz / Nostr transport details (NIP-42, BIP-340, `transport` modes) come
  from a third-party MarkTechPost article, not from repo source in this pass.
  Treat as background, not as an interface to build against.
- The repo's reported star count (~236k) is unusually high and was not
  independently corroborated. It does not affect the protocol facts, which were
  read from the actual source files, but the project's provenance beyond the
  `NousResearch` org name was not separately verified.

Closest documented stable interface, in order of preference for Bond: the
`/v1/runs` + `/v1/runs/{id}/events` HTTP+SSE contract first, then ACP over stdio
for a locally launched Hermes. Both are real and current on `main` as of
2026-08-25.

## Sources

Primary (Nous Research):
- Repo: https://github.com/NousResearch/hermes-agent
- API server source: https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py
- ACP adapter source: https://github.com/NousResearch/hermes-agent/tree/main/acp_adapter
- MCP server source: https://github.com/NousResearch/hermes-agent/blob/main/mcp_serve.py
- Pairing source: https://github.com/NousResearch/hermes-agent/blob/main/gateway/pairing.py
- Docs site: https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/
- Org: https://github.com/NousResearch

Related standards:
- Agent Client Protocol (the ACP that `acp_adapter` implements): https://agentclientprotocol.com
- Model Context Protocol: https://modelcontextprotocol.io

Third-party (background, not interface truth):
- MarkTechPost, Hermes + Buzz integration paths (2026-07-31): https://www.marktechpost.com/2026/07/31/nous-research-ships-three-integration-paths-for-hermes-agent-and-buzz-blocks-open-source-nostr-workspace-for-humans-and-agents/
- Community docs mirror: https://github.com/mudrii/hermes-agent-docs
