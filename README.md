# Bond

Bond is the messaging app for teams of humans and AI agents, where an agent is a
first-class member of the room with a verifiable identity, not a bot bolted onto a
human chat app. Built with Expo (Android-first, plus a web build) for RevenueCat
Shipaton 2026.

The wedge is structural. Telegram, WhatsApp, Slack and Discord all model a conversation
as a timeline of human text with, at most, a shallow one-level thread. That breaks the
moment participants are agents, because an agent conversation is a branching computation:
one turn fans out into parallel tool calls, sub-agents spawn and rejoin, tasks run for
minutes and the payload is machine-readable state, not sentences. Bond treats that shape
as the primary object.

## The four things incumbents cannot add without rebuilding their data model

1. **Proper threading.** The room is a tree with typed cross-edges (a DAG). Any node can
   be a parent, so a thread forks at any depth and collapses cleanly. Ordering is a
   Lamport clock, nodes are immutable, so sync is a conflict-free grow-only log.
2. **Agent-native messages.** Text, tool calls, tool results, streaming token deltas,
   receipts, cards, handoffs and run status are distinct typed nodes, pinned to MCP, A2A
   and SSE shapes, not text with markup.
3. **A universal agent bridge.** One adapter interface, four adapters: Bond's own gateway,
   a generic OpenAI/WebSocket/MCP adapter, Hermes and OpenClaw. A new runtime that speaks
   OpenAI-HTTP or MCP works with no Bond release.
4. **Verifiable identity.** Every user holds an Ed25519 keypair as a `did:key`, generated
   on device and held in secure storage. Messages are signed over RFC 8785 canonical bytes
   and verified offline, with verified, unsigned and tampered badges.

## Layout

- `app/` the Expo app (React Native, TypeScript, Expo Router). Android-first plus web.
- `server/` the own-gateway backend (Fastify + ws): an OpenAI-compatible `/v1` surface,
  a `/sync` WebSocket for the node log, static hosting of the web build, one live URL.
- `docs/` the design document, the six research briefs and the submit packet.

### Key modules in `app/src`

- `model/` the node graph: `node.ts`, `messages.ts` (typed payloads), `thread.ts` (tree,
  ordering, collapse), `factory.ts`.
- `identity/` `keys.ts` (Ed25519 + did:key), `jcs.ts` (RFC 8785), `sign.ts`, `storage.ts`.
- `bridge/` `adapter.ts` (the one interface), `sse.ts`, `net.ts` and `adapters/` (generic,
  own, hermes, openclaw) plus `registry.ts`.
- `store/` the append-only storage port with sqlite (native), web and memory adapters.
- `rooms/` roles and the permission matrix, mention routing and handoff.
- `state/` the zustand app engine tying it together.
- `components/ui` the design system, `components/thread` the message and composer.

## Run it

App (web is the fastest way to see it, Android needs a dev build via EAS):

```bash
cd app
npm install
npm run web        # or: npx expo run:android on a machine with the Android SDK
```

Backend:

```bash
cd server
npm install
cp .env.example .env   # fill in the upstream OpenAI-compatible endpoint and a BOND_BEARER
npm run dev
```

The app talks to the backend through the `bond` adapter. Point it at your server with
`EXPO_PUBLIC_BOND_GATEWAY` and `EXPO_PUBLIC_BOND_TOKEN` in `app/.env`. The backend proxies
an OpenAI-compatible endpoint whose credentials live only in `server/.env`, never in the
app bundle or in tracked files.

## Verification

```bash
cd app
npx tsc --noEmit     # types
npx jest             # 34 unit tests: signing + falsification, threading, bridge, storage
npx expo lint        # 0 errors
npx expo export -p web   # bundles all 13 routes
```

## Build for Android

`eas.json` has development, preview and production profiles. `eas build --platform android
--profile production` produces the AAB in the cloud (no local Android SDK needed). See
`docs/SUBMIT-PACKET.md` for the full Google Play and RevenueCat setup and the closed-test
runway.

## AI disclosure

AI assistance (Claude) was used to build Bond. The design, review and verification are the
author's. Verified locally before submission: the TypeScript typecheck, the unit tests
including the signature falsification test, the lint pass and the web export.
