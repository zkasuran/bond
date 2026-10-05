import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Inline <script> blocks that carry a body (no src attribute).
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/** CSP source expressions ('sha256-...') for every non-empty inline script in one HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const body = m[1];
    if (!body || body.trim() === "") continue;
    out.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return [...out];
}

/** Walk an exported web build and collect the inline-script hashes across all of its HTML. */
export function hashesForDist(dir: string): string[] {
  const out = new Set<string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".html")) for (const h of inlineScriptHashes(readFileSync(p, "utf8"))) out.add(h);
    }
  };
  walk(dir);
  return [...out].sort();
}

/**
 * The strict CSP for the hosted web build. Scripts run only from 'self' plus the
 * exact hashes of the inline scripts the export emitted, never 'unsafe-inline'.
 */
export function buildCsp(scriptHashes: readonly string[]): string {
  const scriptSrc = ["'self'", ...scriptHashes].join(" ");
  return (
    `default-src 'none'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; ` +
    "img-src 'self' data:; font-src 'self' data:; " +
    "connect-src 'self' https://api.devnet.solana.com https://api.mainnet-beta.solana.com https://lite-api.jup.ag; " +
    "base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'"
  );
}
