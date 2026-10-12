#!/usr/bin/env bash
# Bond release gate. One command, run by CI and by a judge, same verdict.
# Prints ALL GREEN only if every check below passes.
set -euo pipefail

cd "$(dirname "$0")"
root="$(pwd)"

# An exported-but-empty provider base URL makes @ai-sdk/* throw at import time.
# Drop empty ones so the gate judges the code, not the caller's shell.
for v in ANTHROPIC_BASE_URL OPENAI_BASE_URL; do
  if [ -n "${!v+x}" ] && [ -z "${!v}" ]; then unset "$v"; fi
done
say() { printf '\n=== %s ===\n' "$1"; }

# ---------------------------------------------------------------------------
# 1. App: type-check (strict), unit tests, lint
# ---------------------------------------------------------------------------
say "app: tsc --noEmit (strict)"
( cd app && npx tsc --noEmit )

say "app: jest (unit + adversarial)"
( cd app && npx jest --ci )

say "app: lint"
( cd app && npm run lint )

# ---------------------------------------------------------------------------
# 2. App: web export (the artifact a judge opens)
# ---------------------------------------------------------------------------
say "app: expo export -p web"
( cd app && npx expo export -p web >/dev/null )
routes=$(find app/dist -name '*.html' | wc -l | tr -d ' ')
echo "web routes emitted: ${routes}"
[ "${routes}" -ge 16 ] || { echo "FAIL: expected at least 16 web routes, got ${routes}"; exit 1; }

say "app: no credential in the client bundle"
# The app authenticates with a device session, so no token, bearer or upstream key may be
# inlined into the web build. Fail on any of their names or on an inlined bearer value.
if grep -rIlE 'EXPO_PUBLIC_BOND_TOKEN|BOND_BEARER|SESSION_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY|AGENT_SOLANA_SECRET|Bearer [A-Za-z0-9._-]{20,}' app/dist >/dev/null; then
  echo "FAIL: a credential name or bearer value is in app/dist"; exit 1
fi
echo "no credential names or bearer values in app/dist"

say "supply chain: bigint-buffer is the patched drop-in"
for d in app server; do
  v=$( cd "${d}" && npm ls bigint-buffer --all 2>/dev/null | grep -oE 'bigint-buffer@[^ ]+' | sort -u | tr '\n' ' ' )
  echo "${d}: ${v:-not present}"
  if [ -n "${v}" ] && echo "${v}" | grep -qvE '^(bigint-buffer@1\.1\.5-bond\.1 ?)+$'; then
    echo "FAIL: ${d} resolves an unpatched bigint-buffer"; exit 1
  fi
done

# ---------------------------------------------------------------------------
# 3. Server: type-check and tests
# ---------------------------------------------------------------------------
say "server: typecheck"
( cd server && npm run typecheck )

say "server: tests (unit + adversarial)"
( cd server && npm test )

# ---------------------------------------------------------------------------
# 4. Supply chain. 0 high/critical is the bar. Exceptions are advisories with
#    NO patched release upstream, each documented in SECURITY.md Supply chain:
#    node-forge (Expo CLI build tooling) and braces (Metro/Jest file matching).
#    Remove each the moment a fix ships. bigint-buffer is no longer allowlisted:
#    it is replaced by the vendored, input-validating vendor/bigint-buffer-safe.
#    decode-uri-component, uuid and stream-json are fixed by overrides too.
# ---------------------------------------------------------------------------
say "supply chain: audit (high and critical fail)"
for d in app server; do
  echo "-- audit: ${d}"
  ( cd "${d}" && npx --yes audit-ci@^7 --high \
      --allowlist GHSA-86w9-cpqp-85rv GHSA-vfj7-8cjw-p6xm )
done

printf '\nALL GREEN\n'
