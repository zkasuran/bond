# Bond server

The own-gateway backend for Bond. One Node + TypeScript service that does three
things on one origin:

- An OpenAI-compatible proxy at `/v1/chat/completions` and `/v1/models`. It
  forwards to the configured upstream, streams SSE straight back and defaults
  the model when a request omits it.
- A sync WebSocket at `/sync` for the threading engine. Clients join a room,
  replay stored nodes since their last Lamport clock, then live-broadcast new
  nodes to the room.
- A static host for the exported web build at `/`, so the whole product is one
  live URL.

`/v1` and `/sync` require a Bearer credential: a one-hour device session, which
is what the app uses, or the operator token `BOND_BEARER`, for ops and curl.
`/health`, `GET /v1/session/challenge` and `POST /v1/session` are open and
rate-limited.

A device gets a session by signing `"Bond session v1\ndid: <did>\nchallenge: <challenge>"`
with its Ed25519 `did:key` and posting `{ did, challenge, signature }` (base64url
signature) to `/v1/session`. The response is `{ token, expiresAt }`. See
`src/session.ts`.

## Run

```bash
npm install
cp .env.example .env
# fill in .env, then:
npm run dev
```

`npm run build` compiles to `dist/`, `npm start` runs the built server.

The sync client connects with `?room=<roomId>` and `Authorization: Bearer
<session>`. A browser or React Native client, which cannot set the header,
passes `?token=<session>` instead.

## Credentials

Copy `.env.example` to `.env` and fill it in. Append your own upstream
OpenAI-compatible endpoint credentials (base URL, API key and model) to `.env`.
`.env` is never committed. Keep `.env.example` neutral.

Set a real `BOND_BEARER` before starting. The server refuses to boot while it is
still the `change-me` placeholder. An empty value disables the operator
credential. Never put `BOND_BEARER` in an app build.

Set `SESSION_SECRET` (`openssl rand -hex 32`) so device sessions survive a
restart. Rotating it revokes every session at once.

## Security

- `/v1` and `/sync` require a device session (HMAC-checked, did-bound, one-hour)
  or the operator token (compared in constant time). Device sessions also get a
  per-did rate limit.
- The sync upgrade enforces an Origin allowlist. A same-origin request and a
  non-browser client are always allowed. Name any extra cross-origin front end in
  `ALLOWED_ORIGINS`.
- Ceilings on rooms, nodes, frame size, request rate, upstream time, upstream
  bytes and agent spend live in one place, `src/limits.ts`.
- The hosted web build is served with a strict Content-Security-Policy:
  `script-src 'self'` plus the exact `'sha256-...'` of each inline script the
  web export emitted. The server reads those hashes from `app/dist` at startup
  (`src/csp.ts`), so they always match the build and the policy never needs
  `'unsafe-inline'`.

