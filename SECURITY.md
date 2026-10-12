# Security

Bond moves value (USDC on devnet) and shows signed identity, so it is built to be attacked. This file is the threat model: one row per attacker and attack, the defence, the file that holds it and whether a test exercises it. The release gate is `./verify.sh`, which CI runs too.

> **Where these fixes live.** Everything described here is the code at the current repo HEAD, after the security audit. The published release APK was cut before the audit, so it does not yet carry these defences. To run the hardened build, rebuild the APK from this HEAD. Until then, treat the downloadable APK as the pre-audit build.

## Trust boundaries

- The device holds an Ed25519 `did:key` that signs chat nodes. It never leaves the device.
- The Seeker wallet, custodied by Seed Vault, signs on-chain actions through Mobile Wallet Adapter. Bond only ever receives signed bytes, never the key.
- The server holds its own agent keypair, the upstream LLM key, `SESSION_SECRET` and the operator `BOND_BEARER`. Clients never see any of them: the app bundle inlines only the public gateway URL and model name, and it authenticates with a short-lived device session signed by its `did:key`.
- The sync server is a relay. It is not trusted to vouch for a node's authorship, so clients re-verify every node.
- Device-local stores (the protection policy, the PIN record, the attempt counter, the wallet binding) are trusted only as far as the device is. On a non-rooted Android or Seeker the OS keystore holds them. On web or a rooted device they are editable, so the integrity checks below raise the bar but the hardware wallet stays the real factor.

## Threats and defences

| Attacker and attack | Defence | File | Tested |
|---|---|---|---|
| A relay or peer injects a node attributed to a victim `did:key` | Every signed node is verified on ingest and re-verified on read. An unsigned node that claims a `did:key` author is rejected and a tampered node is dropped and never rendered as authentic | `app/src/store/guard.ts`, `app/src/identity/sign.ts` | yes, `app/src/store/__tests__/storage.test.ts`, `app/src/identity/__tests__/sign.test.ts` |
| A relay relabels a verified node's shown name or flips its human/agent flag | `authorDisplayName` and `authorKind` are inside the signed field set, so changing either changes the digest and the node reads as tampered | `app/src/model/node.ts`, `app/src/identity/sign.ts` | yes, `app/src/identity/__tests__/sign.test.ts`, `app/src/state/__tests__/engine.test.ts` |
| A node is signed, then its structural edges (`refs`, `causalParent`, `topicId`, `collapsedByDefault`) are rewritten to hide or reparent messages | The signed field set covers every structural edge, so any edge change breaks the signature | `app/src/model/node.ts`, `app/src/identity/sign.ts` | yes, `app/src/identity/__tests__/sign.test.ts` |
| A forged node reuses a real id to shadow the authentic one | Dedupe compares signed content, a differing duplicate id is rejected and a verified node reclaims its id | `app/src/store/guard.ts` | yes, `app/src/store/__tests__/storage.test.ts` |
| A peer presents a payment receipt as a settled transfer | A receipt renders as an unverified claim unless it is re-checked on chain. The network chip, the settled pill and the on-chain settlement line are all gated on that re-check, so a peer-set cluster cannot print a settlement and an unknown cluster reads as unverified | `app/src/components/thread/receipt.ts`, `app/src/components/thread/MessageNode.tsx` | yes, `app/src/components/thread/__tests__/receipt.test.ts`, `app/src/components/thread/__tests__/MessageNode.test.tsx` |
| A peer points a receipt at an unrelated confirmed transfer and sets a crafted amount | When a receipt is bound, `confirmSignature` fetches the transaction and matches amount, mint, sender and recipient against the payload. A mismatch is rejected and never retried. An unfetchable transaction fails closed | `app/src/solana/confirm.ts` | yes, `app/src/solana/__tests__/usdc.test.ts` |
| The agent is talked into draining funds | A hard per-transfer and per-process USDC cap is checked and reserved in one synchronous step before the transfer is built, so concurrent turns cannot race past it. The system prompt is fixed on the server | `server/src/agent/tools.ts`, `server/src/agent/loop.ts`, `server/src/limits.ts` | yes, `server/src/agent/tools.test.ts` |
| A spend slips past the factor gate with a NaN, negative or non-finite amount or on a device with no factor | The gate treats any non-finite or negative amount as requiring auth and fails closed when no factor is available. The fund triggers spend and unlockKey default to a factor so a spend is never silently ungated. openApp and runSkill default to open for a usable first run and can be raised in Protection settings | `app/src/protection/gate.ts`, `app/src/protection/policy.ts` | yes, `app/src/protection/__tests__/gate.test.ts`, `app/src/app/wallet/__tests__/send-gate.test.tsx` |
| An attacker weakens the protection policy to turn a guard off | A weakening change must be proven by a factor that existed before the request, so a PIN enrolled in the same session cannot approve a downgrade. The stored policy carries an HMAC integrity tag and fails closed to the guarded default when the tag is missing or wrong | `app/src/protection/gate.ts`, `app/src/protection/policy.ts`, `app/src/protection/LockGate.tsx` | yes, `app/src/protection/__tests__/gate.test.ts`, `app/src/protection/__tests__/policy.test.ts` |
| A stolen device brute-forces the PIN | A monotonic-clock lockout a date change cannot rewind, an attempt counter that reserves the attempt before the prompt so a concurrent burst cannot probe for free and a fail-closed cooldown applied when the attempts record is deleted while a PIN is enrolled | `app/src/protection/gate.ts` | yes, `app/src/protection/__tests__/gate.test.ts` |
| A revoked wallet session silently swaps the active account mid-transaction | The app refuses to send a transaction whose fee payer it cannot read, so there is always an approved account to compare the session against. It never adopts a silently swapped account | `app/src/solana/wallet.ts` | yes, `app/src/solana/__tests__/reauth.test.ts` |
| A captured or superseded wallet-to-`did` binding is replayed to redirect USDC to a stale wallet | The binding carries both the wallet signature and the `did` signature over a nonce, a context tag and an expiry. It is re-verified on load and a per-`did` monotonic version floor refuses any binding older than the last one seen | `app/src/solana/binding.ts` | yes, `app/src/solana/__tests__/binding.test.ts` |
| A public skill purchase is replayed to unlock the skill for another user | The entitlement is bound to the buyer. The server requires the claimant to prove control of the paying wallet with the device key signature over a fresh server-issued challenge, checks the on-chain payer and requires the platform fee share, so naming a public payer address is not enough | `server/src/agent/skills.ts`, `server/src/agent/route.ts`, `app/src/state/store.ts` | yes, `server/src/agent/skills.test.ts` |
| A malformed or never-ending agent stream hangs or exhausts a client | Bounded parsing, a per-chunk inactivity timeout and total byte, event and wall-clock ceilings, plus an error boundary so one view cannot blank the app. A hostile stream always terminates and cannot grow memory without end | `app/src/bridge/sse.ts`, `app/src/bridge/adapters/*`, `app/src/app/_layout.tsx` | yes, `app/src/bridge/__tests__/sse.test.ts`, `app/src/bridge/__tests__/generic.test.ts` |
| A caller hammers the paid agent proxy or a slow upstream holds a socket open | A per-IP request limiter, an overall upstream deadline on top of a per-chunk idle timer, a relayed-byte cap and a per-client concurrency bound that does not collapse behind a proxy | `server/src/gateway.ts`, `server/src/index.ts`, `server/src/limits.ts` | yes, `server/src/gateway.test.ts` |
| The gateway leaks the upstream key back to a client or is used for SSRF | The client Authorization is never forwarded, the upstream base URL is fixed from env, redirects are not followed and a non-2xx upstream body is replaced with a fixed generic error | `server/src/gateway.ts` | yes, `server/src/gateway.test.ts` |
| An MCP skill import is aimed at an internal address (SSRF) | `isSafeMcpUrl` requires https and rejects `localhost`, `0.0.0.0`, every IPv6 literal and the loopback, private and link-local IPv4 ranges, including the cloud metadata address | `server/src/agent/tools.ts` | yes, `server/src/agent/tools.test.ts` |
| A client floods the sync socket or sends a giant frame to exhaust memory | A per-message size cap, a per-socket rate limit, room and node ceilings, a global store byte budget, socket-backpressure termination, room eviction on empty and a top-level crash guard | `server/src/sync.ts`, `server/src/index.ts`, `server/src/limits.ts` | yes, `server/src/sync.test.ts` |
| A page opens a cross-site WebSocket to the sync server | An origin allowlist is checked at the upgrade, a missing origin is rejected by default and a mismatch is rejected | `server/src/sync.ts` | yes, `server/src/sync.test.ts` |
| A secret is extracted from the APK or web bundle | No credential is inlined. The app signs a 2-minute server challenge with its `did:key` and gets a one-hour, did-bound, HMAC-tagged session. The per-did limiter applies on top of the per-IP one | `server/src/session.ts`, `server/src/index.ts`, `app/src/bridge/session.ts`, `app/src/state/store.ts` | yes, `server/src/session.test.ts`, `app/src/bridge/__tests__/session.test.ts` |
| A timing attack on the bearer token | Both sides are hashed and compared in constant time, an empty configured token denies all and the server refuses to start on the placeholder | `server/src/config.ts` | yes, `server/src/config.test.ts` |
| XSS or clickjacking on the hosted web build | A strict Content-Security-Policy (`default-src 'none'`, scripts by hash), nosniff, `frame-ancestors 'none'`, no `dangerouslySetInnerHTML` | `server/src/index.ts`, `server/src/csp.ts` | yes, `server/src/csp.test.ts` |
| Someone watching the screen learns the PIN from where the taps land | The PIN pad draws a fresh CSPRNG Fisher-Yates layout of the ten digits each time it opens and after each submit, and fails closed with no CSPRNG | `app/src/protection/shuffle.ts`, `PinPad.tsx` | yes, `app/src/protection/__tests__/shuffle.test.ts`, `PinPad.test.tsx` |
| An agent persona or job tries to lift the caps or rewrite the rules | Persona, name, handle and job are sanitized (one line, quotes swapped, capped) and appended to the fixed system prompt as the owner's words, below the rules; the caps live in code | `server/src/agent/route.ts`, `loop.ts`, `limits.ts` | yes, `server/src/agent/job.test.ts` |
| A JSON API response is sniffed, framed or cached by an intermediary | Every API and health response carries nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS and `Cache-Control: no-store`, the SSE stream included | `server/src/index.ts`, `server/src/agent/route.ts` | yes, `server/src/config.test.ts` |
| A corrupted or hostile `localStorage` value crashes the web app or forges a node | The parse is guarded, returns empty on malformed data and caps the parsed length. An unsigned `did:key` node planted at rest is dropped on read | `app/src/store/web.ts`, `app/src/store/guard.ts` | yes, `app/src/store/__tests__/storage.test.ts` |

## Agent wallet: funding, caps, revocation

The agent pays from its own server-held keypair, because a Seed Vault wallet always prompts and cannot sign unattended. It is never a user's wallet, so the most a compromised or misled agent can move is what the operator put in it, further bounded by the caps below.

| Concern | How it works today | Code | Tested |
|---|---|---|---|
| Funding | The operator sets `AGENT_SOLANA_SECRET` (base58 or JSON byte array) and sends devnet USDC and SOL for fees to its public key. With no secret, a fresh ephemeral keypair is generated per process, holds nothing and cannot pay. The secret is never logged or returned; only the public key leaves the server | `server/src/config.ts`, `loadWallet` in `server/src/agent/tools.ts` | yes, `server/src/agent/tools.test.ts` (`loadWallet …`) |
| Per-transfer cap | `solana_transfer_usdc` refuses any amount over `MAX_AGENT_TRANSFER_USDC` (100 USDC), and any non-finite, zero or negative amount, before a transaction is built | `server/src/limits.ts`, `server/src/agent/tools.ts` | yes, `rejects an amount over the per-transfer cap`, `rejects a non-positive amount` |
| Cumulative cap | Each transfer reserves its amount against `MAX_AGENT_TRANSFER_TOTAL_USDC` (500 USDC) synchronously before any `await`, so parallel turns cannot race past it. A failed send releases its reservation | `server/src/agent/tools.ts` | yes, `concurrent transfers cannot drain past the per-process ceiling` |
| Runaway loops | A turn stops after `MAX_AGENT_STEPS` (8) tool steps. A larger client-requested `maxSteps` is clamped down to it | `server/src/limits.ts`, `server/src/agent/route.ts`, `server/src/agent/loop.ts` | partly, the clamp is in code, the loop tests cover message handling |
| Prompt injection | The system prompt is fixed on the server, and a client-supplied `system` message is dropped. The caps are checks in code, so no message can raise or bypass them | `server/src/agent/loop.ts` | yes, `toModelMessages drops a client-supplied system message` |
| Which tools it can call | Four built-in tools: `solana_get_balance`, `solana_transfer_usdc` (devnet), `solana_price`, and `solana_swap_quote`, which returns an unsigned transaction and never signs. Paid skill tools join a turn only after `verifyClaims` proves an on-chain purchase by the claimant. MCP tools come only from the operator-set `MCP_SKILL_URL`, never from a client, and are SSRF-filtered, size-bounded and time-limited | `server/src/agent/tools.ts`, `server/src/agent/skills.ts` | yes, `tools.test.ts`, `skills.test.ts` |
| Visibility | Every `tool_call` and `tool_result`, including transfer signatures, streams into the thread as its own node, so the room sees exactly what the agent did | `server/src/agent/events.ts`, `server/src/agent/loop.ts` | yes, client side, `app/src/bridge/__tests__/generic.test.ts` |
| Revocation | Operator-side. Sweep the wallet's remaining USDC to a safe address, then unset or rotate `AGENT_SOLANA_SECRET` and restart. With no secret the agent comes back on an empty ephemeral key, so its transfer tool can no longer move funds. Rotating the shared `BOND_BEARER` cuts off every client at once | `server/src/config.ts` | no, it's an operational procedure |

Limits stated plainly: the cumulative cap is in memory, so it resets when the process restarts, and the real ceiling across restarts is the wallet balance. There is one agent wallet per deployment, not one per user, so a user cannot set their own budget or revoke the agent from the app. Per-user agent wallets with an on-chain allowance (for example an SPL token delegate the user can revoke from their own wallet) are planned, not built.

## Production trust model

In one line: everything that moves money is on devnet with test tokens, mainnet is read only, and nothing on mainnet is built yet. The tiers are spelled out for users in the [README](README.md#is-it-safe-for-me-today).

Who enforces each rule. A judge can check the on-chain rows on Solana Explorer without trusting Bond at all.

| Layer | What it enforces | What it cannot enforce |
|---|---|---|
| **Solana (on chain)** | A human payment moves only when the Seed Vault wallet signs it (`transferChecked`, exact mint and decimals). A skill purchase is one atomic transaction, so creator and platform are either both paid or neither is. Balances and token-account ownership | Who may chat or call the agent. How much the agent may spend: the agent's keypair can sign anything its balance allows |
| **Bond server** | Device-session auth on `/v1` and `/sync` ([`session.ts`](server/src/session.ts)). Per-IP and per-did rate limits. The agent's spend caps and step cap ([`limits.ts`](server/src/limits.ts)). A fixed system prompt. Skill unlock only after it re-reads the purchase on chain *and* checks a wallet-ownership proof ([`skills.ts`](server/src/agent/skills.ts)). Message, room and socket ceilings on sync | Message authenticity, which the device checks itself. Anything after the agent's keypair or `SESSION_SECRET` leaks (see below) |
| **Device** | Signs every node with its `did:key` and re-verifies every node on read. Shows a receipt as settled only after its own on-chain re-check ([`confirm.ts`](app/src/solana/confirm.ts)). The PIN or biometric gate before a spend reaches the wallet ([`gate.ts`](app/src/protection/gate.ts)) | Anything on a rooted device or in web `localStorage`, which the user fully controls |

### Failure modes

| Failure | What happens | Code | Tested |
|---|---|---|---|
| Solana RPC down or erroring during a skill unlock | The skill stays locked for that turn, never unlocked by default. A license already verified stays cached for that buyer only | `verifyClaims` in `server/src/agent/skills.ts` | yes, `skills.test.ts` |
| RPC error during an agent transfer | The tool returns `ok: false` with the error, and the amount reserved against the cap is released. A transaction that was sent but never confirmed still counts against the cap, which errs on the safe side | `solana_transfer_usdc` in `server/src/agent/tools.ts` | yes, `tools.test.ts` |
| RPC down while a receipt is shown | The receipt reads as an unverified claim, not as settled. A transaction it cannot fetch fails closed | `app/src/solana/confirm.ts` | yes, `usdc.test.ts` |
| Replay of a session challenge or token | A challenge is HMAC-tagged and lasts 2 minutes. A token is bound to one did, lasts 1 hour, and any edit to it breaks the MAC | `server/src/session.ts` | yes, `session.test.ts` |
| Replay of a skill purchase by someone else | Rejected: the claim must be signed by the `did:key` that a wallet-signed binding ties to the on-chain payer | `server/src/agent/skills.ts` | yes, `skills.test.ts` |
| Replay of a relayed chat node | Deduplicated by signed content. A changed copy fails verification and is dropped | `app/src/store/guard.ts` | yes, `storage.test.ts` |
| **Agent keypair leaks** | The attacker can spend whatever the agent wallet holds, because caps live in Bond's code and not on chain. User wallets are untouched, since Bond never holds their keys. Response: drain the wallet to a safe address, then rotate `AGENT_SOLANA_SECRET`. Keep the wallet funded only with what a demo needs | `server/src/agent/tools.ts` | operational |
| **`SESSION_SECRET` leaks** | The attacker can mint sessions for any did. That gives the same access as any visitor, under the same rate limits and spend caps. Response: rotate it, which revokes every session and skill challenge at once | `server/src/secret.ts` | yes, `rotating the server secret revokes every outstanding session` |
| **`BOND_BEARER` leaks** | Operator access to `/v1` and `/sync`, still under the IP rate limit and the agent caps. Response: rotate it. It is never in a client bundle | `server/src/config.ts` | yes, `session.test.ts` |
| Upstream LLM key leaks | Cost exposure on the provider. It never leaves the server, and the gateway never forwards client credentials | `server/src/gateway.ts` | yes, `gateway.test.ts` |
| Sync relay compromised | It can withhold or reorder nodes. It cannot forge or alter them, because clients re-verify every signature | `app/src/store/guard.ts` | yes |

## HTML sinks in the website and deck

An automated scan flagged places in `site/` where values were written as HTML. As of 1.3.6 there are none left: `site/assets/site.js` and `site/deck/deck.js` contain no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`.

| Location | What it was | Now |
|---|---|---|
| `site/assets/site.js`, signature playground `render()` | Wrote the canonical JSON of a node, including **text the visitor types**, as HTML | Built from text nodes and `textContent`. An `<img onerror>` payload creates no element |
| `site/deck/deck.js`, headline split and restore for print | Re-parsed the deck's own headline markup | Keeps and restores cloned DOM nodes |
| `site/assets/site.js`, thread replay (`el`, `msg`, `stream`), tool card, receipt | Built from constant strings | Built element by element with `createElement` and text; the agent reply streams as text nodes |
| `site/assets/site.js`, terminal replay | Built from a constant `lines` array | Spans and text nodes |

The same scan flagged two `generic-api-key` matches, `site/index.html:187` and `site/deck/index.html:210`. Both were `did:key:z6Mk…` identifiers, which are Ed25519 *public* keys shown as the demo identity, so they were never secrets. The site and deck now show them shortened (`did:key:z6MkpMwQ…PavARoQ`), and the full public values a judge may want to check on Explorer are in the README.

The scan's low-severity notes that Bond imports `@solana/web3.js` v1 (in maintenance) are accurate. The move to `@solana/kit` is planned after the hackathon. It touches every wallet, payment and RPC call, and v1 still receives security fixes.

Defence in depth: neither page reads URL parameters, `postMessage` or the network into the DOM. The deck reads `location.hash` only through `/^#\/(\d+)$/` and `/^#(s\d\d)$/` to pick a slide number. Both pages ship a CSP meta tag with `default-src 'none'`, `connect-src 'none'` and `script-src 'self'` (the site adds one sha256 hash), so injected markup could not run inline script or send data out.

## Known limits

Stated plainly, because an unlabelled gap is worse than a named one.

- Device-local storage (the protection policy, the PIN record, the attempt counter, the wallet binding) is only as strong as the device. On a non-rooted Android or Seeker the OS keystore protects it. On web or a rooted device it is editable, so the integrity tag on the policy and the version floor on the binding stop naive or accidental writes, not a determined attacker on a store they fully control. The real factor is the hardware wallet in Seed Vault, which Bond never holds. On web the device signing key itself sits in `localStorage` in plaintext, readable by any script on the origin.
- A single very large WebSocket frame from a hostile relay can still exhaust memory on a mobile client before the JavaScript size cap runs, because the platform WebSocket buffers the whole frame first. A native max-payload bound is the complete fix.
- The skills entitlement proof is replayable only inside its short challenge window (about five minutes), and only by the device that holds the bound `did:key`, since the claim is signed by it. A one-time server nonce is the complete fix.
- A 4-digit PIN is a convenience factor and is offline-crackable if the stored record leaks. The hardware wallet is the real security. The PIN pad shuffles its digits with a CSPRNG every time it opens (`app/src/protection/shuffle.ts`), which defeats watching where taps land, not a camera on the screen.
- An agent's persona and per-room job are the owner's own words. The server folds each to one quoted line, caps it at 600 characters and adds it to the fixed system prompt as a request (`server/src/agent/route.ts`, `loop.ts`). That limits how much it can do, but a model can still be talked into odd behaviour by text its owner wrote; what cannot change is the spend caps, which are enforced in code.
- The SKR holder discount is derived from a client read, not a server attestation. A server-side re-derivation at settlement is future work.
- The MCP import check validates literal hosts. A hostname that resolves to an internal address (DNS rebinding) is not caught. The MCP URL is operator-set and is never taken from a client request.
- Everything settles on devnet. The only mainnet calls are reads: the Jupiter swap quote and the SKR price and balance. No mainnet funds move.
- A device session proves control of a `did:key`, and a `did:key` is free to mint, so sessions do not decide *who* may use the public app. Nothing shipped in a public client can. What they buy is no extractable secret in the bundle, one-hour tokens, revocation by rotating `SESSION_SECRET`, and a per-did rate limit on top of the per-IP one. Spend is bounded by the agent caps, not by authentication.
- APKs up to 1.3.1 and web builds before 1.3.2 inlined the old `EXPO_PUBLIC_BOND_TOKEN`. That value is public and was retired: `BOND_BEARER` was rotated on the live server on 2026-10-12 after 1.3.2 shipped, so the extracted value no longer authenticates. Install 1.3.2 or later, which use device sessions.
- The agent keypair is ephemeral unless `AGENT_SOLANA_SECRET` is set to a funded devnet keypair, so agent-initiated transfers only work once that is provisioned.
- The `/sync` WebSocket takes its credential in a `?token=` query parameter, because neither browsers nor React Native can set a WebSocket header, so it can land in intermediary access logs. It is a one-hour device session, so a logged token expires. The operator bearer should never be used there.

## Supply chain

`verify.sh` runs `audit-ci --high` in both workspaces and fails on any high or critical finding.

- **Fixed:** `GHSA-3gc7-fjrx-p6mg` (CVE-2025-3194) in `bigint-buffer@1.1.5`, pulled by `@solana/spl-token` through `@solana/buffer-layout-utils`. It has no patched upstream release, so both workspaces replace it via npm `overrides` with [`vendor/bigint-buffer-safe`](vendor/bigint-buffer-safe/index.js). That is about 60 lines of pure JS with no native binding, and it implements only the four functions `buffer-layout-utils` calls. It rejects non-buffer, non-bigint, negative and over-width input with an error, where the original overflowed or silently truncated. It was checked to give identical output to the original on 15,000 random u8 to u256 round trips. `npm ls bigint-buffer` now resolves to `1.1.5-bond.1` in both lockfiles, and the advisory is no longer allowlisted.

- **Fixed:** `stream-json@1.9.1` (GHSA-528h-pc64-c93x, GHSA-hqr4-qq8f-hg3x, GHSA-mjw6-4jj6-33hc) and `uuid@8.3.2` (GHSA-w5hq-g745-h8pq). Both came only through `jayson@4`, the JSON-RPC client inside `@solana/web3.js`. Both workspaces override `jayson` to `5.0.0`, which depends on neither: it generates request ids with `crypto.randomUUID` or `getRandomValues`, which `polyfill.js` provides on device. web3.js loads only `jayson/lib/client/browser`, whose interface is unchanged. Checked with real devnet calls: `getSlot`, `getBalance`, `getParsedTransaction` on the recorded purchase, a batched `getParsedTransactions`, and an RPC error that surfaces correctly.
- **Fixed:** `uuid@7.0.3` (GHSA-w5hq-g745-h8pq) in the app, which `xcode` pulls in through Expo config plugins at prebuild time. It is overridden to `11.1.1`; `xcode` only calls `v4()`.
- **Fixed:** `decode-uri-component@0.2.2` (GHSA-vcc3-ghjq-m6fr, exponential decoding), which `query-string@7` pulls in through `expo-router`. The fixed upstream release is ESM-only and `query-string@7` loads it with `require()`, so the app overrides it with [`vendor/decode-uri-component-safe`](vendor/decode-uri-component-safe/index.js). It is the same API with a linear-time fallback. A crafted 2,000-token input takes about 28 ms, against about 98 s in the original. Its output matches the original on 14 of 15 edge cases. The one difference is a lone malformed `%C2`, which it keeps as written instead of turning into `U+FFFD`.

`npm audit` reports 0 vulnerabilities in the server. Two upstream-unfixable advisories remain allowlisted in the app, both build-time only:

- `GHSA-86w9-cpqp-85rv` in `node-forge` (all versions up to 1.4.0, the latest, no patched release). Pulled only by Expo's CLI code-signing tooling at build time. It is not bundled into the APK or the web export.
- `GHSA-vfj7-8cjw-p6xm` in `braces` (all versions up to 3.0.3, the latest, no patched release). A glob-pattern DoS reachable only through Metro and Jest file matching at build and test time, with developer-controlled patterns. It is not bundled into the APK or the web export.

The allowlist is reviewed whenever dependencies change and an entry is removed the moment an upstream fix ships.

## Reporting

This is a hackathon build. Report an issue by opening a GitHub issue on the repository.
