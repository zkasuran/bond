# Bond — Shipaton 2026 build brief

Bond is an agentic-era messaging app: the chat surface for a world where agents are
first-class participants, not bots bolted onto a human app. It replaces the Telegram /
WhatsApp / Slack model with proper threading, agent-native messages, humans and agents
sharing one room, verifiable signed identity, and a universal bridge so any agent
runtime (Hermes, OpenClaw, a generic gateway, or Bond's own) plugs in.

Entry for **RevenueCat Shipaton 2026**. This brief is the anchor. The full technical
design lands in `DESIGN.md` (produced by the research workflow). `research/` holds the
source briefs.

## Confirmed decisions (from zkasuran, 2026-08-25)

- **Platform:** Android-first with React Native + Expo, plus an Expo web build for a
  live URL. Built here via EAS cloud build (this box has no local Android SDK).
- **Store path:** go for a real Shipaton submission. Build publish-ready and hand off
  the exact enrollment + closed-test steps. zkasuran will create the Google Play +
  RevenueCat accounts.
- **Agent bridge:** universal pluggable bridge. One adapter interface, four adapters:
  Bond's own gateway, a generic OpenAI-compatible / WebSocket / MCP adapter, Hermes,
  OpenClaw. Future runtimes drop in behind the same interface.
- **Features:** all four are must-haves — proper threading, agent-native messages,
  humans + agents in one room, verifiable identity + signed messages — plus whatever
  else raises it to best-in-class. Goal is to win.

## The hard Shipaton facts (verified 2026-08-25)

- Window Aug 1 to Sep 30 2026. **Submission deadline Sep 30, 11:45pm PT.** Judging
  Oct 1 to 13, winners around Oct 21.
- Must be a **brand-new** app, publicly live on App Store, Google Play or Samsung
  Galaxy Store. **TestFlight, "in review" and closed testing do NOT count** — a judge
  must be able to download it.
- Must integrate the **RevenueCat SDK** to power at least one in-app purchase, or serve
  ads via RevenueCat Ads.
- Submission needs: text description, an under-2-minute demo video (the first 2 minutes
  are what screeners and judges watch), the public store URL, a 1024x1024 icon,
  screenshots, and a free trial or a judge promo code.
- Judging: screeners and judges score 1-5 per targeted category. A RevenueCat dev
  advocate downloads the app to confirm it matches the video.

## The runway is the real risk (human-gated, money-gated)

New personal Google Play accounts must run a **closed test with 12 testers for 14
continuous days** before applying for production, then production review takes up to
about a week. Apple is ~2 weeks. RevenueCat's own advice: start closed testing by
Sep 1, be publicly live by ~Sep 23. Starting Aug 25, the Google Play path is tight but
possible if the closed test starts within days.

Human + money steps zkasuran must own (I build everything up to these and hand off the
exact commands):

- Create a Google Play developer account ($25 one-time) with identity + banking/tax
  verification.
- Create a RevenueCat account, add the app, set up the Play billing integration and the
  Bond Pro product with a free trial.
- Recruit 12 testers and start the 14-day closed test as early as possible.
- Upload the signed AAB (produced by EAS) and promote to production once review clears.

## Category strategy

Target **Design Award** (product craft, polish, animation) and **HAMM** (smartest use
of RevenueCat to drive revenue). Not Grand Prize — that turns on paid user traction and
growth, which we will not buy. Every design decision serves those two: a paywall and
Pro tier that are a genuine, well-placed monetization story (HAMM) and an interface that
is visibly crafted (Design Award).

## Bond Pro (the monetization story, refined in DESIGN.md)

Free: core messaging, one agent bridge, threading, signed identity. Pro (subscription,
with free trial): multiple simultaneous bridges, more agents per room, premium model
routing, verification badges, larger context / history. The paywall sits where the user
hits the value ceiling (adding a second bridge or a third agent), not at the door.

## Non-negotiables carried from house rules

- The house LLM gateway powers Bond's own backend. Never name the gateway or the exact
  model in any tracked file, commit, PR, the store listing, the video or the app. Keep
  `.env.example` neutral; real values live only in the lane `.env` from `.gateway.env`.
- Any network endpoint Bond exposes must state its auth posture. No unauthenticated
  service ships silently.
- Bond users get their OWN generated did:key identity. This is NOT the FLOP identity —
  that key is never reused here.
- Repo starts private, flips public at submit (a Shipaton judge must reach it and the
  store listing). Verify as an anonymous stranger, not with our authenticated gh.
- House writing style on every outward word (store listing, video, packet): no em
  dashes, no comma before "and"/"or", plain and direct.

## Build order (living)

1. Research → `DESIGN.md` (workflow running).
2. Scaffold Expo app green (running).
3. Core: threading + agent-native message model.
4. Universal bridge adapters.
5. Verifiable identity + signing.
6. Humans + agents room, routing, handoff.
7. Own-gateway backend + live web URL.
8. RevenueCat paywall + free trial + entitlements.
9. Onboarding + paywall + UI polish (Design Award craft).
10. Tests + lint + typecheck green.
11. Publish: private→public repo, EAS Android build, web deploy, submit packet, store
    enrollment handoff, demo-video offer.
