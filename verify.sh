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
#    bigint-buffer (via @solana/spl-token), node-forge (Expo CLI build tooling)
#    and braces (Metro/Jest file matching). Remove each the moment a fix ships.
# ---------------------------------------------------------------------------
say "supply chain: audit (high and critical fail, bigint-buffer allowlisted)"
for d in app server; do
  echo "-- audit: ${d}"
  ( cd "${d}" && npx --yes audit-ci@^7 --high \
      --allowlist GHSA-3gc7-fjrx-p6mg GHSA-86w9-cpqp-85rv GHSA-vfj7-8cjw-p6xm )
done

printf '\nALL GREEN\n'
