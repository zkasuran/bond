# Security

Bond moves value (USDC on devnet) and shows signed identity, so it is built to be attacked. This file is the threat model: one row per attacker and attack, the defence, the file that holds it, and whether a test exercises it. The release gate is `./verify.sh`, which CI runs too.

## Trust boundaries

- The device holds an Ed25519 `did:key` that signs chat nodes. It never leaves the device.
- The Seeker wallet, custodied by Seed Vault, signs on-chain actions through Mobile Wallet Adapter. Bond only ever receives signed bytes, never the key.
- The server holds its own agent keypair and the upstream LLM key. Clients never see either.
- The sync server is a relay. It is not trusted to vouch for a node's authorship, so clients re-verify every node.

## Threats and defences

| Attacker and attack | Defence | File | Tested |
|---|---|---|---|
| A relay or peer injects a node attributed to a victim `did:key` | Every signed node is verified on ingest and re-verified on read, a tampered node is dropped and never rendered as authentic | `app/src/store/guard.ts`, `app/src/identity/sign.ts` | yes, `store/__tests__/storage.test.ts`, `identity/__tests__/sign.test.ts` |
| A node is signed, then its unsigned edges (`refs`, `causalParent`, `topicId`, `collapsedByDefault`) are rewritten to hide or reparent messages | The signed field set is single-sourced and covers the structural edges, so any edge change breaks the signature | `app/src/model/node.ts`, `app/src/identity/sign.ts` | yes, `identity/__tests__/sign.test.ts` |
| A forged node reuses a real id to shadow the authentic one | Dedupe compares signed content, a differing duplicate id is rejected and a verified node reclaims its id | `app/src/store/guard.ts`, the store adapters | yes, `store/__tests__/storage.test.ts` |
| The agent is talked into draining funds | A hard per-transfer and per-process USDC cap is enforced in code before the transfer is built, and the system prompt is fixed on the server | `server/src/agent/tools.ts`, `server/src/agent/loop.ts`, `server/src/limits.ts` | yes, `server/src/agent/tools.test.ts` |
| A spend slips past the factor gate with a NaN, negative or non-finite amount, or on a device with no biometric and no PIN | The gate treats any non-finite or negative amount as requiring auth and fails closed when no factor is available | `app/src/protection/gate.ts` | yes, `protection/__tests__/gate.test.ts` |
| A stolen device brute-forces the PIN | A persisted failed-attempt counter with backoff and lockout | `app/src/protection/gate.ts` | yes, `protection/__tests__/gate.test.ts` |
| A client floods the sync socket or sends a giant frame to exhaust memory | A per-message size cap, per-socket rate limit, room and node ceilings, room eviction on empty, and a top-level crash guard | `server/src/sync.ts`, `server/src/index.ts`, `server/src/limits.ts` | yes, `server/src/sync.test.ts` |
| A page opens a cross-site WebSocket to the sync server | An origin allowlist is checked at the upgrade, a mismatch is rejected | `server/src/sync.ts` | yes, `server/src/sync.test.ts` |
| A caller hammers the paid agent proxy, or a slow upstream holds a socket open | A per-IP request limiter, an upstream timeout, a relayed-byte cap and a concurrency bound | `server/src/gateway.ts`, `server/src/index.ts`, `server/src/limits.ts` | yes, `server/src/gateway.test.ts` |
| The gateway leaks the upstream key back to a client, or is used for SSRF | The client Authorization is never forwarded, the upstream base URL is fixed from env and not client-controlled | `server/src/gateway.ts` | yes, `server/src/gateway.test.ts` |
| A timing attack on the bearer token | Both sides are hashed and compared in constant time, an empty configured token denies all, the server refuses to start on the placeholder | `server/src/config.ts` | yes, `server/src/*.test.ts` |
| XSS or clickjacking on the hosted web build | A strict Content-Security-Policy (`default-src 'none'`, scripts by hash), nosniff, `frame-ancestors 'none'`, no `dangerouslySetInnerHTML` | `server/src/index.ts`, `server/src/csp.ts` | yes, `server/src/csp.test.ts` |
| A corrupted or hostile `localStorage` value crashes the web app | The parse is guarded, returns empty on malformed data and caps the parsed length | `app/src/store/web.ts` | yes, `store/__tests__/storage.test.ts` |
| A malformed or never-ending agent stream hangs or crashes a client | Bounded parsing, a per-chunk inactivity timeout, and an error boundary so one view cannot blank the app | `app/src/bridge/*`, `app/src/app/_layout.tsx` | yes, bridge tests |

## Known limits

Stated plainly, because an unlabelled gap is worse than a named one.

- The device bearer ships inside the public APK as `EXPO_PUBLIC_BOND_TOKEN`, so it authenticates the deployment, not an individual user. It is paired with a rate limiter and the agent spend cap, so a token holder cannot drain funds or exhaust the service. A per-user auth model is future work.
- The agent keypair is ephemeral unless `AGENT_SOLANA_SECRET` is set to a funded devnet keypair, so agent-initiated transfers only work once that is provisioned.
- Everything settles on devnet. The only mainnet calls are reads: the Jupiter swap quote and the SKR price and balance. No mainnet funds move.
- A skill entitlement is cached locally for speed, but the authoritative proof is the on-chain USDC transfer signature, which is re-checkable against the cluster. The local cache is not treated as authority.
- The `/sync` WebSocket accepts the bearer in a `?token=` query parameter for browser clients that cannot set a header, which can land in intermediary access logs. Native clients use the header.

## Supply chain

`verify.sh` runs `audit-ci --high` in both workspaces and fails on any high or critical finding. Three upstream-unfixable advisories are allowlisted and tracked here:

- `GHSA-3gc7-fjrx-p6mg` in `bigint-buffer`, pulled by `@solana/spl-token`. There is no patched release, and the only npm-offered fix is a breaking downgrade of the Solana stack. Removed from the server by dropping `solana-agent-kit`, still present under the app's SPL token dependency.
- `GHSA-86w9-cpqp-85rv` in `node-forge` (all versions up to 1.4.0, the latest; no patched release). Pulled only by Expo's CLI code-signing tooling at build time. It is not bundled into the APK or the web export.
- `GHSA-vfj7-8cjw-p6xm` in `braces` (all versions up to 3.0.3, the latest; no patched release). A glob-pattern DoS reachable only through Metro and Jest file matching at build and test time, with developer-controlled patterns. Not bundled into the APK or the web export.

The allowlist is reviewed whenever dependencies change, and an entry is removed the moment an upstream fix ships.

## Reporting

This is a hackathon build. Report an issue by opening a GitHub issue on the repository.

