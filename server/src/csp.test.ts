import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCsp, hashesForDist, inlineScriptHashes } from "./csp.js";

// The Expo Router web export's hydrate flag, and its known sha256.
const HYDRATE = "globalThis.__EXPO_ROUTER_HYDRATE__=true;";
const HYDRATE_HASH = "'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='";

test("inlineScriptHashes hashes inline bodies and skips src scripts and empty bodies", () => {
  const html = `<script type="module">${HYDRATE}</script><script src="/a.js" defer></script><script> </script>`;
  assert.deepEqual(inlineScriptHashes(html), [HYDRATE_HASH]);
});

test("hashesForDist walks nested html and dedupes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "csp-"));
  mkdirSync(path.join(dir, "room"));
  writeFileSync(path.join(dir, "index.html"), `<script>${HYDRATE}</script>`);
  writeFileSync(path.join(dir, "room", "x.html"), `<script>${HYDRATE}</script><script>b()</script>`);
  writeFileSync(path.join(dir, "room", "skip.js"), `<script>c()</script>`);
  const hashes = hashesForDist(dir);
  assert.equal(hashes.length, 2);
  assert.ok(hashes.includes(HYDRATE_HASH));
});

test("buildCsp allows exactly self plus the hashes, never unsafe-inline scripts", () => {
  const csp = buildCsp([HYDRATE_HASH]);
  const scriptSrc = /script-src ([^;]+);/.exec(csp)?.[1] ?? "";
  assert.equal(scriptSrc, `'self' ${HYDRATE_HASH}`);
  assert.ok(!scriptSrc.includes("unsafe-inline"));
  assert.match(csp, /frame-ancestors 'none'/);
});

test("buildCsp keeps default-src none and the exact connect-src allowlist", () => {
  const csp = buildCsp([]);
  assert.match(csp, /^default-src 'none';/);
  const connectSrc = /connect-src ([^;]+);/.exec(csp)?.[1] ?? "";
  assert.equal(
    connectSrc,
    "'self' https://api.devnet.solana.com https://api.mainnet-beta.solana.com https://lite-api.jup.ag",
  );
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
});
