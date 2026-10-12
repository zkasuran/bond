// Device session for the Bond gateway. No secret ships in the app bundle: the app proves
// control of its on-device did:key by signing a fresh server challenge and gets back a
// short-lived token (see server/src/session.ts). The token is cached in memory only, refreshed
// shortly before it expires and dropped on a 401 so the next call re-authenticates.
import { base64urlnopad } from "@scure/base";
import { signBytes } from "../identity/keys";
import { getStreamingFetch, joinUrl } from "./net";

/** Refresh this long before the server's expiry so a token never lapses mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface SessionSigner {
  did: string;
  secretKey: Uint8Array;
}

/** The exact bytes the server verifies. Must match server/src/session.ts sessionMessageBytes. */
export function sessionMessage(did: string, challenge: string): Uint8Array {
  return new TextEncoder().encode(["Bond session v1", `did: ${did}`, `challenge: ${challenge}`].join("\n"));
}

interface Cached {
  baseUrl: string;
  did: string;
  token: string;
  expiresAt: number;
}

let cached: Cached | null = null;
let inflight: Promise<string | undefined> | null = null;

/** Forget the cached token, e.g. after the server answered 401. */
export function invalidateSession(): void {
  cached = null;
}

async function mint(baseUrl: string, signer: SessionSigner): Promise<string | undefined> {
  const f = getStreamingFetch();
  const ch = await f(joinUrl(baseUrl, "session/challenge"), { method: "GET" });
  if (!ch.ok) return undefined;
  const { challenge } = (await ch.json()) as { challenge?: unknown };
  if (typeof challenge !== "string") return undefined;
  const signature = base64urlnopad.encode(signBytes(sessionMessage(signer.did, challenge), signer.secretKey));
  const res = await f(joinUrl(baseUrl, "session"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: signer.did, challenge, signature }),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { token?: unknown; expiresAt?: unknown };
  if (typeof body.token !== "string" || typeof body.expiresAt !== "number") return undefined;
  cached = { baseUrl, did: signer.did, token: body.token, expiresAt: body.expiresAt };
  return body.token;
}

/**
 * A valid session token for this gateway and identity, minting one when needed. Undefined
 * when there is no identity yet or the gateway is unreachable, so the caller sends no
 * credential and the server answers 401, which fails closed.
 */
export async function sessionToken(
  baseUrl: string,
  signer: SessionSigner | null,
  now: number = Date.now(),
): Promise<string | undefined> {
  if (!signer) return undefined;
  if (
    cached &&
    cached.baseUrl === baseUrl &&
    cached.did === signer.did &&
    cached.expiresAt - REFRESH_MARGIN_MS > now
  ) {
    return cached.token;
  }
  // One mint at a time, so a burst of callers on launch shares a single round trip.
  if (!inflight) {
    inflight = mint(baseUrl, signer)
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
