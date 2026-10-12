// Device sessions. The app never ships a static secret: it proves control of its on-device
// Ed25519 did:key by signing a fresh server challenge, and gets back a short-lived session
// token the server MACs with SESSION_SECRET, which never leaves the server. The operator
// bearer (BOND_BEARER) is still accepted for ops and curl, but it is no longer inlined into
// any client bundle, so the APK and the web build carry nothing worth extracting.
//
// What this does and does not buy: a did:key is free to mint, so a session does not gate WHO
// may use a public app (nothing shipped in a public client can). It removes the extractable
// secret, makes every token short-lived and revocable (rotate SESSION_SECRET), and gives each
// caller a stable identity the server rate-limits on, on top of the per-IP limiter.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config, bearerMatches } from "./config.js";
import { didKeyToPublicKey, verifyEd25519 } from "./agent/skills.js";
import { serverSecret } from "./secret.js";

export const SESSION_TOKEN_PREFIX = "bs1";
export const SESSION_TTL_MS = 60 * 60 * 1000;
export const SESSION_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const CHALLENGE_DOMAIN = "bond:session-challenge:v1";
const TOKEN_DOMAIN = "bond:session-token:v1";
const MAX_DID_LEN = 128;
const utf8 = new TextEncoder();

function mac(domain: string, data: string): string {
  return createHmac("sha256", `${domain}:${serverSecret()}`).update(data).digest("hex");
}

function macEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** The exact bytes the app signs with its did:key. Must match app/src/bridge/session.ts. */
export function sessionMessageBytes(did: string, challenge: string): Uint8Array {
  return utf8.encode(["Bond session v1", `did: ${did}`, `challenge: ${challenge}`].join("\n"));
}

/** A short-lived, stateless challenge: `<expiresAt>.<mac>`. */
export function issueSessionChallenge(now: number = Date.now()): string {
  const expiresAt = now + SESSION_CHALLENGE_TTL_MS;
  return `${expiresAt}.${mac(CHALLENGE_DOMAIN, String(expiresAt))}`;
}

export function verifySessionChallenge(challenge: unknown, now: number = Date.now()): boolean {
  if (typeof challenge !== "string" || challenge.length > 256) return false;
  const dot = challenge.indexOf(".");
  if (dot <= 0) return false;
  const expiresAt = Number(challenge.slice(0, dot));
  if (!Number.isInteger(expiresAt) || now > expiresAt) return false;
  if (expiresAt - now > SESSION_CHALLENGE_TTL_MS + CLOCK_SKEW_MS) return false;
  return macEquals(challenge.slice(dot + 1), mac(CHALLENGE_DOMAIN, String(expiresAt)));
}

export interface IssuedSession {
  token: string;
  expiresAt: number;
}

/** Exchange a signed challenge for a session token. Null on any failure, never a throw. */
export function issueSession(
  body: unknown,
  now: number = Date.now(),
): IssuedSession | null {
  if (!body || typeof body !== "object") return null;
  const { did, challenge, signature } = body as Record<string, unknown>;
  if (typeof did !== "string" || did.length > MAX_DID_LEN || did.includes(".")) return null;
  if (typeof signature !== "string" || signature.length > 128) return null;
  if (!verifySessionChallenge(challenge, now)) return null;
  let publicKey: Uint8Array;
  try {
    publicKey = didKeyToPublicKey(did);
  } catch {
    return null;
  }
  const sig = new Uint8Array(Buffer.from(signature, "base64url"));
  if (!verifyEd25519(sessionMessageBytes(did, challenge as string), sig, publicKey)) return null;
  const expiresAt = now + SESSION_TTL_MS;
  const payload = `${SESSION_TOKEN_PREFIX}.${did}.${expiresAt}`;
  return { token: `${payload}.${mac(TOKEN_DOMAIN, payload)}`, expiresAt };
}

/** The did a still-valid session token was issued to, or null. */
export function verifySessionToken(token: string | null, now: number = Date.now()): string | null {
  if (!token || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_TOKEN_PREFIX) return null;
  const [, did, exp, tag] = parts;
  const expiresAt = Number(exp);
  if (!Number.isInteger(expiresAt) || now > expiresAt) return null;
  if (expiresAt - now > SESSION_TTL_MS + CLOCK_SKEW_MS) return null;
  if (!macEquals(tag, mac(TOKEN_DOMAIN, `${SESSION_TOKEN_PREFIX}.${did}.${exp}`))) return null;
  return did;
}

export type Principal = { kind: "operator" } | { kind: "device"; did: string };

/** Who a presented credential belongs to: the operator bearer, a device session, or nobody. */
export function authenticate(presented: string | null, now: number = Date.now()): Principal | null {
  if (presented == null) return null;
  if (presented.startsWith(`${SESSION_TOKEN_PREFIX}.`)) {
    const did = verifySessionToken(presented, now);
    return did ? { kind: "device", did } : null;
  }
  return bearerMatches(presented, config.bondBearer) ? { kind: "operator" } : null;
}
