# Security

Bond moves value (USDC on devnet) and shows signed identity, so it is built to be attacked. This file is the threat model: one row per attacker and attack, the defence, the file that holds it and whether a test exercises it. The release gate is `./verify.sh`, which CI runs too.

> **Where these fixes live.** Everything described here is the code at the current repo HEAD, after the security audit. The published release APK was cut before the audit, so it does not yet carry these defences. To run the hardened build, rebuild the APK from this HEAD. Until then, treat the downloadable APK as the pre-audit build.

## Trust boundaries

- The device holds an Ed25519 `did:key` that signs chat nodes. It never leaves the device.
- The Seeker wallet, custodied by Seed Vault, signs on-chain actions through Mobile Wallet Adapter. Bond only ever receives signed bytes, never the key.
- The server holds its own agent keypair and the upstream LLM key. Clients never see either.
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
| A spend slips past the factor gate with a NaN, negative or non-finite amount or on a device with no factor | The gate treats any non-finite or negative amount as requiring auth, fails closed when no factor is available and a sensitive action never defaults to no factor | `app/src/protection/gate.ts` | yes, `app/src/protection/__tests__/gate.test.ts`, `app/src/app/wallet/__tests__/send-gate.test.tsx` |
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
| A timing attack on the bearer token | Both sides are hashed and compared in constant time, an empty configured token denies all and the server refuses to start on the placeholder | `server/src/config.ts` | yes, `server/src/config.test.ts` |
| XSS or clickjacking on the hosted web build | A strict Content-Security-Policy (`default-src 'none'`, scripts by hash), nosniff, `frame-ancestors 'none'`, no `dangerouslySetInnerHTML` | `server/src/index.ts`, `server/src/csp.ts` | yes, `server/src/csp.test.ts` |
| A corrupted or hostile `localStorage` value crashes the web app or forges a node | The parse is guarded, returns empty on malformed data and caps the parsed length. An unsigned `did:key` node planted at rest is dropped on read | `app/src/store/web.ts`, `app/src/store/guard.ts` | yes, `app/src/store/__tests__/storage.test.ts` |

## Known limits

Stated plainly, because an unlabelled gap is worse than a named one.

- Device-local storage (the protection policy, the PIN record, the attempt counter, the wallet binding) is only as strong as the device. On a non-rooted Android or Seeker the OS keystore protects it. On web or a rooted device it is editable, so the integrity tag on the policy and the version floor on the binding stop naive or accidental writes, not a determined attacker on a store they fully control. The real factor is the hardware wallet in Seed Vault, which Bond never holds. On web the device signing key itself sits in `localStorage` in plaintext, readable by any script on the origin.
- A single very large WebSocket frame from a hostile relay can still exhaust memory on a mobile client before the JavaScript size cap runs, because the platform WebSocket buffers the whole frame first. A native max-payload bound is the complete fix.
- The skills entitlement proof is replayable only inside its short challenge window (about five minutes). A per-connection nonce is the complete fix and needs the per-user session the shared-bearer deployment does not have.
- A 4-digit PIN is a convenience factor and is offline-crackable if the stored record leaks. The hardware wallet is the real security.
- The SKR holder discount is derived from a client read, not a server attestation. A server-side re-derivation at settlement is future work.
- The MCP import check validates literal hosts. A hostname that resolves to an internal address (DNS rebinding) is not caught. The MCP URL is operator-set and is never taken from a client request.
- Everything settles on devnet. The only mainnet calls are reads: the Jupiter swap quote and the SKR price and balance. No mainnet funds move.
- The device bearer ships inside the public APK as `EXPO_PUBLIC_BOND_TOKEN`, so it authenticates the deployment, not an individual user. It is paired with a rate limiter and the agent spend cap, so a token holder cannot drain funds or exhaust the service. A per-user auth model is future work.
- The agent keypair is ephemeral unless `AGENT_SOLANA_SECRET` is set to a funded devnet keypair, so agent-initiated transfers only work once that is provisioned.
- The `/sync` WebSocket accepts the bearer in a `?token=` query parameter for browser clients that cannot set a header, which can land in intermediary access logs. Native clients use the header.

## Supply chain

`verify.sh` runs `audit-ci --high` in both workspaces and fails on any high or critical finding. Three upstream-unfixable advisories are allowlisted and tracked here:

- `GHSA-3gc7-fjrx-p6mg` in `bigint-buffer`, pulled by `@solana/spl-token` (through `@solana/buffer-layout-utils`) in both the app and the server. There is no patched release and the only npm-offered fix is a breaking downgrade of the Solana stack. It is present in both workspaces. An earlier note that it had been removed from the server was wrong: dropping `solana-agent-kit` removed one path to it, but `@solana/spl-token` still pulls it on the server as well as in the app.
- `GHSA-86w9-cpqp-85rv` in `node-forge` (all versions up to 1.4.0, the latest, no patched release). Pulled only by Expo's CLI code-signing tooling at build time. It is not bundled into the APK or the web export.
- `GHSA-vfj7-8cjw-p6xm` in `braces` (all versions up to 3.0.3, the latest, no patched release). A glob-pattern DoS reachable only through Metro and Jest file matching at build and test time, with developer-controlled patterns. It is not bundled into the APK or the web export.

The allowlist is reviewed whenever dependencies change and an entry is removed the moment an upstream fix ships.

## Reporting

This is a hackathon build. Report an issue by opening a GitHub issue on the repository.
