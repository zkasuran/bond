# Evidence

Everything here can be re-run. Nothing is mocked: the tests drive the real APK, the live server at `bond.zkasuran.dev` and Solana devnet.

- [Device run on Android 15](#device-run-on-android-15): 13 of 13 steps pass, with a screenshot for each
- [Wider end-to-end run](#wider-end-to-end-run): 150 cases across the API, web app and APK
- [Release gate in CI](#release-gate-in-ci)
- [Audit findings and their fixes](#audit-findings-and-their-fixes)
- [What this does not prove](#what-this-does-not-prove)

## Device run on Android 15

[`tools/device-e2e.py`](../../tools/device-e2e.py) uninstalls Bond, installs the signed release APK and drives it through the UI with adb. It runs against the live server, and the agent turn is a real tool call on devnet. Re-run it with one device or emulator attached:

```bash
python3 tools/device-e2e.py Bond-1.3.6.apk docs/evidence/device-e2e
```

Last run: **Bond 1.3.6** (versionCode 12, the v1.3.6 release APK), Android 15 emulator (`sdk_gphone64_x86_64`), 2026-10-12 20:27 UTC. Raw results: [`device-e2e/results.json`](device-e2e/results.json).

| Step | Result | What the screen showed | Screenshot |
|---|---|---|---|
| Fresh install and launch shows onboarding | PASS | Installed, version 1.3.6 | [01](device-e2e/01-fresh-install-and-launch-shows-onboarding.jpg) |
| Onboarding shows the device `did:key` | PASS | A did:key made on the device | [02](device-e2e/02-onboarding-shows-the-device-did-key.jpg) |
| First-run lock choice, then enter Bond | PASS | Nothing, PIN, Fingerprint or face | [03](device-e2e/03-first-run-lock-choice-then-enter-bond.jpg) |
| Home shows an empty rooms list | PASS | No rooms yet | [04](device-e2e/04-home-shows-an-empty-rooms-list.jpg) |
| Create a room with the Bond agent | PASS | 1 human · 1 agent | [05](device-e2e/05-create-a-room-with-the-bond-agent.jpg) |
| Typed `@bond` runs a real devnet tool call | PASS | `solana_get_balance` called and returned | [06](device-e2e/06-typed-bond-runs-a-real-devnet-tool-call.jpg) |
| Tool card is labelled agent-reported | PASS | "Agent-reported. Not a signed on-chain receipt." | [07](device-e2e/07-tool-card-is-labelled-agent-reported.jpg) |
| Own message carries a Verified badge | PASS | Verified | [08](device-e2e/08-own-message-carries-a-verified-badge.jpg) |
| Create agent Scout with `@username` and persona | PASS | Scout (@scout) joined | [09](device-e2e/09-create-agent-scout-with-username-and-persona.jpg) |
| Typed `@scout` gets a reply from Scout in persona | PASS | "AHOY, I'm Scout, yer pirate mate for Solana devnet…" | [10](device-e2e/10-typed-scout-gets-a-reply-from-scout-in-persona.jpg) |
| Agents tab lists your agents by `@username` | PASS | @bond and @scout | [11](device-e2e/11-agents-tab-lists-your-agents-by-username.jpg) |
| Rooms persist across a cold restart | PASS | The room is still there | [12](device-e2e/12-rooms-persist-across-a-cold-restart.jpg) |
| No crash in logcat | PASS | No `FATAL EXCEPTION` | [13](device-e2e/13-no-crash-in-logcat.jpg) |

Wallet signing over Mobile Wallet Adapter was proven separately on the same emulator with Solana Mobile's reference test wallet. The three devnet transactions in the [README](../../README.md#for-judges) come from that run, and each can be checked on Solana Explorer.

## Wider end-to-end run

A run on 2026-10-12 covered 150 cases against the live surfaces. Raw results: [`api1.json`](api1.json), [`api2.json`](api2.json), [`api3.json`](api3.json), [`web.json`](web.json), [`web2.json`](web2.json). Session tokens are removed, and long ids are shortened.

| Surface | Cases | What it covered |
|---|---|---|
| API and sync | 73 | Headers; `assetlinks.json` matching the APK cert; every forged, expired or tampered session and token; every `/v1` route without auth; agent-turn validation; real devnet tools, including one finalized 0.01 USDC transfer; a 101 USDC request rejected by the cap in code; prompt injection; two-device sync relay, room isolation, replay and oversize frames; the rate limiter |
| Web app | 65 | Onboarding and the lock choice; PIN enrol, lock, wrong PIN, lockout and the shuffled layout; rooms; `@username` mentions, personas, several agents, import; bridge validation; wallet, market and pay sheets that fail closed without a wallet; deep links; persistence; themes; keyboard |
| APK | 12 | Update in place, lock, agents, rotation, relock after backgrounding, no crash |

The run found four bugs. All are fixed in 1.3.5 and 1.3.6: a reloaded room URL returned a 404, the PIN layout repeated, an unknown room link opened an empty room, and a lowercase lockout message. It also found three low items, fixed in 1.3.6: headers on API responses, a raw "Failed to fetch" message, and an SKR price flicker.

## Release gate in CI

[`.github/workflows/verify.yml`](../../.github/workflows/verify.yml) runs [`verify.sh`](../../verify.sh) on every push to master: [Actions](https://github.com/zkasuran/bond/actions/workflows/verify.yml). The gate fails unless all of these pass:
- the app type-check, 369 tests and lint
- the web export
- **no credential name or bearer value in the built client bundle**
- **both workspaces resolve the patched `bigint-buffer`**
- the server type-check and 95 tests
- the supply-chain audit for high and critical advisories

## Audit findings and their fixes

The hosted audit ran on `b1d9f04`, which is before these fixes. A re-run on current master is pending.

| Finding (audit `b1d9f04`) | Fix | How to check |
|---|---|---|
| **High:** a secret inlined into the client (`EXPO_PUBLIC_BOND_TOKEN`, `app/src/state/store.ts:42`) | `ca6e58e`: the app no longer ships any credential. It signs a 2-minute server challenge with its device `did:key` and gets a one-hour session ([`server/src/session.ts`](../../server/src/session.ts)). The old value was retired by rotating `BOND_BEARER` on the live server on 2026-10-12, after 1.3.2 shipped | `verify.sh` fails if a credential name or bearer value is in `app/dist`; `grep -r BOND_TOKEN app/src` finds nothing |
| **High:** `bigint-buffer@1.1.5` (GHSA-3gc7-fjrx-p6mg) | `ca6e58e`: replaced in both workspaces by [`vendor/bigint-buffer-safe`](../../vendor/bigint-buffer-safe/index.js), which validates its input | `verify.sh` fails unless `npm ls bigint-buffer` is `1.1.5-bond.1` in both |
| Medium: `uuid`, `stream-json`, `decode-uri-component` | `bbe36af` | `audit-ci --high` in `verify.sh` |
| High, unconfirmed: HTML written as markup in `site/` and the deck (11) | 3 fixed in `ca6e58e`; the other 8 were constant-only and are now rebuilt with DOM nodes too. No `innerHTML` is left in `site/` | `grep -c innerHTML site/assets/site.js site/deck/deck.js` prints 0 |
| Unconfirmed: `generic-api-key` at `site/index.html:187`, `site/deck/index.html:210` | These were public `did:key` identifiers, not secrets. Both pages now show them shortened | `grep -cE '[1-9A-HJ-NP-Za-km-z]{32,}' site/index.html site/deck/index.html` prints 0 |
| Low: `@solana/web3.js` v1 (16) | Acknowledged. The move to `@solana/kit` comes after the hackathon | [`SECURITY.md`](../../SECURITY.md#supply-chain) |

## What this does not prove

- **Real users.** Bond has no users, builders or retention data yet, and nothing here claims any. The repeat-use loop and how it will be measured are in the README under [Stickiness and product-market fit](../../README.md#stickiness-and-product-market-fit).
- **A physical Seeker.** The device runs are on the Android 15 emulator. MWA signing used Solana Mobile's reference test wallet, not Seed Vault hardware.
- **Mainnet.** Nothing that moves money runs on mainnet. See [Is it safe for me today?](../../README.md#is-it-safe-for-me-today).
