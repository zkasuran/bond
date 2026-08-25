# Bond server

The own-gateway backend for Bond. One Node + TypeScript service that does three
things on one origin:

- An OpenAI-compatible proxy at `/v1/chat/completions` and `/v1/models`. It
  forwards to the configured upstream, streams SSE straight back, and defaults
  the model when a request omits it.
- A sync WebSocket at `/sync` for the threading engine. Clients join a room,
  replay stored nodes since their last Lamport clock, then live-broadcast new
  nodes to the room.
- A static host for the exported web build at `/`, so the whole product is one
  live URL.

`/v1` and `/sync` require the shared Bearer token (`BOND_BEARER`). `/health`
returns `{ "ok": true }` and is open.

## Run

```bash
npm install
cp .env.example .env
# fill in .env, then:
npm run dev
```

`npm run build` compiles to `dist/`, `npm start` runs the built server.

The sync client connects with `?room=<roomId>` and `Authorization: Bearer
<BOND_BEARER>`. A browser that cannot set the header can pass `?token=<BOND_BEARER>`
instead.

## Credentials

The real upstream host, key and model for this workspace live in the repo-root
`.gateway.env` and are appended to `.env`. They are never committed. Keep
`.env.example` neutral.

```bash
cat ../../../.gateway.env >> .env
```
