// Wallet to identity binding. Bond's device identity is an Ed25519 did:key (identity/keys.ts).
// The connected Seeker wallet is a separate Solana keypair. We tie them together once with a
// challenge the WALLET signs, proving the same person controls both. The device key keeps
// signing messages per node; the wallet is the displayed identity and the USDC payer. We do
// this once rather than per message because MWA prompts the user on every wallet signature.
//
// This module has no native or web3.js imports at load, so it runs under jest. The wallet is
// pulled in with a dynamic import only inside bindWalletToIdentity, which is Android-only.
import * as SecureStore from "expo-secure-store";
import { base64urlnopad } from "@scure/base";
import {
  didToPublicKey,
  keypairFromSecret,
  signBytes,
  solanaAddressToPublicKey,
  verifyBytes,
} from "../identity/keys";
import type { WalletConnection } from "./wallet";

const utf8 = new TextEncoder();
const BINDING_KEY_PREFIX = "bond.walletBinding.";
const BINDING_VERSION_KEY_PREFIX = "bond.walletBindingVer.";

/** Domain tag mixed into every binding message, so a signature produced for a Bond binding
 *  cannot be lifted into another app's binding or an unrelated signing prompt. Bump the
 *  suffix on any message-format change. */
export const BINDING_CONTEXT = "bond:wallet-did-binding:v1";

/** How long a binding stays valid. A binding is long lived by design, but not forever: a
 *  captured binding stops verifying after this window so it cannot be replayed indefinitely. */
export const BINDING_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Tolerance for an issuedAt that reads a little ahead of the verifier's clock. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface BindingChallenge {
  /** The device did:key being bound. */
  did: string;
  /** base58 Solana address of the wallet being bound. */
  walletAddress: string;
  /** Random per-binding value, fresh for every challenge. */
  nonce: string;
  /** Domain/context tag, always BINDING_CONTEXT for a Bond binding. */
  context: string;
  /** Monotonic epoch per did. A rebind must strictly supersede the stored version. */
  version: number;
  /** ISO 8601 timestamp the challenge was issued. */
  issuedAt: string;
  /** ISO 8601 timestamp after which the binding no longer verifies. */
  expiresAt: string;
}

export interface WalletBinding extends BindingChallenge {
  /** base64url Ed25519 signature by the WALLET over the challenge message. */
  walletSignature: string;
  /** base64url Ed25519 signature by the device DID:KEY over the same message. */
  didSignature: string;
  boundAt: string;
}

/** What a successful bind returns: the stored binding and the live wallet session it signed
 *  with, so the caller can persist a usable token rather than only the address. */
export interface BindResult {
  binding: WalletBinding;
  connection: WalletConnection;
}

/** The exact human-readable text both parties sign. Deterministic from the challenge so a
 *  verifier rebuilds the same bytes. Binds the did, the wallet, a fresh nonce, the context
 *  tag, the version and the validity window, so no field can change without breaking both
 *  signatures. The wallet shows this to the user at signing time. */
export function buildBindingMessage(challenge: BindingChallenge): string {
  return [
    "Bond wallet binding v1",
    `context: ${challenge.context}`,
    `did: ${challenge.did}`,
    `wallet: ${challenge.walletAddress}`,
    `nonce: ${challenge.nonce}`,
    `version: ${challenge.version}`,
    `issued: ${challenge.issuedAt}`,
    `expires: ${challenge.expiresAt}`,
  ].join("\n");
}

/** UTF-8 bytes of the binding message, the payload passed to the wallet to sign. */
export function bindingMessageBytes(challenge: BindingChallenge): Uint8Array {
  return utf8.encode(buildBindingMessage(challenge));
}

/** MWA returns the message with a 64-byte Ed25519 signature. Take the trailing 64 bytes;
 *  a payload that is exactly 64 bytes is already the bare signature. */
export function extractSignature(signedPayload: Uint8Array): Uint8Array {
  if (signedPayload.length < 64) {
    throw new Error("Signed payload is too short to contain a signature");
  }
  return signedPayload.slice(signedPayload.length - 64);
}

/** Verify a two-sided binding: the wallet signature against the claimed wallet address AND
 *  the did signature against the claimed did, over the same message, within the validity
 *  window and at or above `expectedVersion` (the monotonic version floor for this did).
 *  Returns false rather than throwing on any malformed input. Both sides must sign, so
 *  neither a wallet alone nor a did alone can mint a binding for the other. A genuinely
 *  signed but superseded binding below the floor is refused as a replay or downgrade. */
export function verifyBinding(
  binding: WalletBinding,
  expectedVersion: number,
  opts: { now?: number; context?: string } = {},
): boolean {
  try {
    if (!binding || typeof binding !== "object") return false;
    if (typeof binding.version !== "number" || binding.version < 1) return false;
    // Monotonic version floor: a genuinely signed but superseded binding (a version below
    // the one last saved for this did) is a replay or downgrade and is refused at the point
    // trust is granted, not only at write time.
    if (!Number.isFinite(expectedVersion) || binding.version < expectedVersion) return false;
    if (opts.context && binding.context !== opts.context) return false;

    const now = opts.now ?? Date.now();
    const expiresAt = Date.parse(binding.expiresAt);
    const issuedAt = Date.parse(binding.issuedAt);
    if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
    if (!Number.isFinite(issuedAt) || issuedAt - now > CLOCK_SKEW_MS) return false;

    const message = bindingMessageBytes(binding);
    const walletKey = solanaAddressToPublicKey(binding.walletAddress);
    const didKey = didToPublicKey(binding.did);
    const walletSig = base64urlnopad.decode(binding.walletSignature);
    const didSig = base64urlnopad.decode(binding.didSignature);
    return verifyBytes(walletSig, message, walletKey) && verifyBytes(didSig, message, didKey);
  } catch {
    return false;
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("No CSPRNG available for the binding nonce");
  }
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// SecureStore keys allow only [A-Za-z0-9._-] and a did:key contains a colon, so map it.
export function bindingKey(did: string): string {
  return BINDING_KEY_PREFIX + did.replace(/[^A-Za-z0-9._-]/g, "_");
}

// The companion key holding the monotonic version floor (high-water mark) for a did.
function versionKey(did: string): string {
  return BINDING_VERSION_KEY_PREFIX + did.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** The highest binding version ever stored for this did, 0 when none is on record. A loaded
 *  or verified binding must meet this floor, so a re-planted older binding is refused on read
 *  rather than only blocked on write. */
async function readVersionFloor(did: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(versionKey(did));
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Raise the stored version floor to `version` when it is higher. Monotonic: it never
 *  decreases, so no previously superseded version can be made to verify again. */
async function bumpVersionFloor(did: string, version: number): Promise<void> {
  if (!Number.isInteger(version) || version < 1) return;
  if (version > (await readVersionFloor(did))) {
    await SecureStore.setItemAsync(versionKey(did), String(version));
  }
}

/** Persist a binding. Guards a rebind: a still-valid stored binding is only replaced by one
 *  that strictly supersedes its version, and switching to a different wallet needs explicit
 *  consent (`allowRebind`). A dead or unverifiable stored binding never blocks a fresh one. */
export async function saveBinding(binding: WalletBinding, opts: { allowRebind?: boolean } = {}): Promise<void> {
  const existingRaw = await SecureStore.getItemAsync(bindingKey(binding.did));
  if (existingRaw) {
    let existing: WalletBinding | null = null;
    try {
      existing = JSON.parse(existingRaw) as WalletBinding;
    } catch {
      existing = null;
    }
    if (existing && verifyBinding(existing, 1)) {
      if (!(binding.version > existing.version)) {
        throw new Error("A current wallet binding already exists for this identity; a rebind must use a newer version");
      }
      if (existing.walletAddress !== binding.walletAddress && !opts.allowRebind) {
        throw new Error("This identity is already bound to a different wallet; clear the binding before rebinding");
      }
    }
  }
  await SecureStore.setItemAsync(bindingKey(binding.did), JSON.stringify(binding));
  // Record the new version as the floor so a later re-plant of an older binding is refused.
  await bumpVersionFloor(binding.did, binding.version);
}

/** Load a binding and RE-VERIFY it before returning it. A tampered walletAddress, a broken
 *  signature, an expired window or a did mismatch returns null, so a stored value is never
 *  trusted as a payout identity without the signatures still checking out on read. */
export async function loadBinding(did: string): Promise<WalletBinding | null> {
  const raw = await SecureStore.getItemAsync(bindingKey(did));
  if (!raw) return null;
  let parsed: WalletBinding;
  try {
    parsed = JSON.parse(raw) as WalletBinding;
  } catch {
    return null;
  }
  if (parsed.did !== did) return null;
  // Reject a superseded binding on read: a genuine but older version re-planted under this
  // did must not re-verify, even though its signatures are real and it is inside the TTL.
  const floor = await readVersionFloor(did);
  if (!verifyBinding(parsed, floor, { context: BINDING_CONTEXT })) return null;
  await bumpVersionFloor(did, parsed.version);
  return parsed;
}

export async function clearBinding(did: string): Promise<void> {
  await SecureStore.deleteItemAsync(bindingKey(did));
}

export async function isWalletBound(did: string): Promise<boolean> {
  return (await loadBinding(did)) !== null;
}

/** Bind the connected wallet to the device did:key with a TWO-sided challenge: the wallet
 *  signs it through MWA and the device did:key counter-signs the same bytes. The caller must
 *  hold the device key for `did`, else the bind is refused, so a binding is always for this
 *  device's own identity. Verifies both signatures, guards a rebind, stores the binding and
 *  returns it with the live session it signed with. Android-only via the dynamic wallet
 *  import. Pass an existing connection to skip a second authorize prompt. */
export async function bindWalletToIdentity(
  did: string,
  deviceSecretKey: Uint8Array,
  connection?: WalletConnection,
  opts: { allowRebind?: boolean } = {},
): Promise<BindResult> {
  if (keypairFromSecret(deviceSecretKey).did !== did) {
    throw new Error("The device key does not control the did being bound");
  }
  const wallet = await import("./wallet");
  const conn = connection ?? (await wallet.connectWallet());

  const prevRaw = await SecureStore.getItemAsync(bindingKey(did));
  let prevVersion = 0;
  if (prevRaw) {
    try {
      prevVersion = (JSON.parse(prevRaw) as WalletBinding).version ?? 0;
    } catch {
      prevVersion = 0;
    }
  }
  // A rebind must strictly exceed the monotonic version floor, not just the stored binding,
  // so a new binding is always above any version seen before, even after a clear.
  const floor = await readVersionFloor(did);
  const nextVersion = Math.max(prevVersion, floor) + 1;

  const now = Date.now();
  const challenge: BindingChallenge = {
    did,
    walletAddress: conn.address,
    nonce: randomNonce(),
    context: BINDING_CONTEXT,
    version: nextVersion,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + BINDING_TTL_MS).toISOString(),
  };
  const message = bindingMessageBytes(challenge);
  const signedPayload = await wallet.signMessage(message, {
    authToken: conn.authToken,
    addressBase64: conn.addressBase64,
  });
  const walletSignature = extractSignature(signedPayload);
  const didSignature = signBytes(message, deviceSecretKey);

  const binding: WalletBinding = {
    ...challenge,
    walletSignature: base64urlnopad.encode(walletSignature),
    didSignature: base64urlnopad.encode(didSignature),
    boundAt: new Date().toISOString(),
  };
  if (!verifyBinding(binding, binding.version, { context: BINDING_CONTEXT })) {
    throw new Error("Wallet or device signature did not verify for this binding");
  }
  await saveBinding(binding, opts);
  return { binding, connection: conn };
}
