# Bond submit packet (Shipaton 2026)

The build is feature-complete and green. This packet is what zkasuran needs to publish it
and submit. It separates what is already done from the account, money and device steps only
a human can do.

## Status

- App: Expo SDK 57, React Native, TypeScript, Expo Router. Android-first plus a web build.
- `tsc --noEmit` clean, `expo lint` 0 errors, `jest` 34 tests passing (signing with a
  falsification test, threading, the bridge adapters, storage), `expo export -p web`
  bundles all 13 routes, and `playwright test` passes 2 end-to-end flows on the web build.
- A signed release APK is built: `Bond-1.0.0.apk` (115 MB, universal across all four ABIs,
  Hermes, JS bundled, package com.zkasuran.bond, target SDK 36). It is debug-keystore signed
  for sideload and device testing. A Play upload uses an EAS-built AAB with a release key.
- Backend proven end to end: `/health` ok, bearer auth enforced (401 without, 200 with),
  a real chat completion round-tripped through the house gateway.
- Screens: onboarding, Rooms, Room view (branching threads, collapse, @mention routing,
  live streaming, per-message verified badge), Agents, bridge connect, You, paywall, room
  settings.

Target categories: **Design Award** (product craft) and **HAMM** (smartest use of
RevenueCat to drive revenue). Not Grand Prize, which turns on paid growth we will not buy.

## The critical path is the store runway, not the code

A judge must be able to download the app. TestFlight and "in review" do not count. A new
personal Google Play account must run a closed test with 12 testers for 14 continuous days
before production, then production review takes up to about a week. Start the closed test
within days or the Sep 30 deadline is at risk. The web build is the fast fallback and the
live URL the submission can point at while Play approval is pending.

## Human steps (accounts, money, devices) — do these first

1. **Google Play developer account** ($25 one-time). Complete identity plus banking and tax
   verification. This can take a few days, so start now.
2. **RevenueCat account.** Create the app, connect the Google Play billing integration,
   create the `pro` entitlement, one Offering with an annual (default), monthly and lifetime
   package, and configure the 7-day free trial as an introductory offer on the Play product.
   Copy the Android public SDK key.
3. **Wire the keys (no secrets in git):**
   - `app/.env`: `EXPO_PUBLIC_RC_ANDROID_KEY=<the goog_ key>`, `EXPO_PUBLIC_BOND_GATEWAY=<your deployed backend>/v1`, `EXPO_PUBLIC_BOND_TOKEN=<the BOND_BEARER you set on the server>`.
   - `server/.env`: the upstream OpenAI-compatible endpoint (append the workspace `.gateway.env`) plus `BOND_BEARER` and `PORT`.
<!-- PACKET_APPEND_1 -->

## Automatable (run these; some need the account to exist first)

Deploy the backend and the web build for the live URL:

```bash
cd server && npm install && npm run build
# deploy dist + node to a host that allows a long-lived WebSocket (Fly.io or a small VM).
# it serves the exported web build at / and hosts /v1 and /sync on one origin.
cd ../app && npx expo export -p web   # produces app/dist, served by the backend
```

Build and ship the Android app with EAS (no local Android SDK needed):

```bash
cd app
npm install -g eas-cli   # once
eas login                 # zkasuran
eas build --platform android --profile production   # cloud AAB, EAS-managed signing
eas submit --platform android --latest              # upload to the closed testing track
```

Then, on Google Play Console:

1. Create the app, fill the store listing, data safety and content rating.
2. Add 12+ testers to the closed testing track and have them opt in on real devices.
3. Keep 12 testers opted in for 14 continuous days. A tester dropping resets that clock.
4. Apply for production, answer the three Console sections, wait for review.
5. Roll out to production. Verify the public store URL as a stranger (signed out).

## Devpost submission (draft, house style)

- **Title:** Bond — messaging for humans and agents
- **Tagline:** The chat app where an AI agent is a real, verifiable member of the room.
- **Description:**
  Bond is a messaging app built for the agentic era. Telegram, Slack and Discord model a
  chat as a flat timeline of human text with a shallow thread on top. That falls apart once
  agents join, because agent work branches: parallel tool calls, sub-agents, long-running
  tasks, machine-readable results. Bond makes that structure the primary object.
  Every room is a tree with typed cross-edges, so a thread forks at any depth and collapses
  cleanly. Messages are typed: text, tool calls, tool results, streaming tokens, receipts,
  cards and handoffs, not text with markup. A universal bridge connects Hermes, OpenClaw,
  your own gateway or any OpenAI-compatible runtime through one adapter. Every message is
  signed on device with an Ed25519 did:key and verified offline, so you can see who really
  said what.
  Bond Pro, powered by RevenueCat, unlocks your whole team of agents in one verified space:
  unlimited rooms, every bridge at once, multiple agents per room and unlimited runs, with a
  7-day free trial.
- **Built during the event:** the whole app, the threading and signing engine, the bridge
  adapters and the RevenueCat integration.
- **Categories to tag:** Design Award and HAMM only. Leave the others blank.
- **Links:** the live web URL, the public Play listing, the repo (public at submit).
- **Free trial:** 7-day trial on the Pro product, plus a judge promo code as a fallback.

## Demo video

Follow the beat sheet in `docs/DESIGN.md` section 11: 0:00 pitch, 0:15 the aha moment on a
real device (create a room, message Bond, the reply streams in-thread, the verified badge
appears), 0:45 the craft beat (thread collapse, motion, the branching UI), 1:15 the paywall
and the Pro story, 1:45 proof and the live URL on screen. Keep the whole pitch inside the
first two minutes. Everything shown must be real, because a RevenueCat advocate downloads
finalists. The video is built with the house kit when zkasuran gives the go.

## Secrets checklist (nothing sensitive in git)

- `server/.env` and `app/.env` are gitignored. The upstream endpoint and key live only in
  `server/.env`. The app only ever holds the Bond server URL and the shared bearer.
- The gateway and the exact model are never named in tracked code, the store listing, the
  video or the app. Outward it is "a top-tier OpenAI-compatible model".
- The repo starts private and flips public at submit. Verify as a signed-out stranger that
  the repo page and every cited link resolve.

## AI disclosure

AI assistance (Claude) was used to build Bond. The design, review and verification are the
author's. Verified before submission: the TypeScript typecheck, the unit tests including the
signature falsification test, the lint pass and the web export bundle.

