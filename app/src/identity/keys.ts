// Ed25519 key + did:key primitives. Pure crypto, no storage, no RN-only imports, so
// this runs unchanged on native, web and under Node for tests. See DESIGN.md sec 5.
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { base58, base64urlnopad } from "@scure/base";

// noble-ed25519 v3 needs a synchronous SHA-512 configured for sync sign/verify.
ed.hashes.sha512 = sha512;

// multicodec prefix for an ed25519 public key, per the did:key convention.
const ED25519_PUB_MULTICODEC = Uint8Array.of(0xed, 0x01);
const DID_KEY_PREFIX = "did:key:z";

export interface RawKeypair {
  /** 32-byte ed25519 seed. Secret, never leaves the device store. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  did: string;
}

function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error(
      "No CSPRNG available. Import 'react-native-get-random-values' at the app entry point.",
    );
  }
  return c.getRandomValues(new Uint8Array(n));
}

export function generateKeypair(): RawKeypair {
  const secretKey = randomBytes(32);
  const publicKey = ed.getPublicKey(secretKey);
  return { secretKey, publicKey, did: publicKeyToDid(publicKey) };
}

/** Reconstruct a keypair from a stored 32-byte secret seed. */
export function keypairFromSecret(secretKey: Uint8Array): RawKeypair {
  if (secretKey.length !== 32) {
    throw new Error("ed25519 secret seed is not 32 bytes");
  }
  const publicKey = ed.getPublicKey(secretKey);
  return { secretKey, publicKey, did: publicKeyToDid(publicKey) };
}

/** Reconstruct a keypair from a stored base64url secret, returning null on anything that is
 *  not a valid 32-byte ed25519 seed. A corrupted or hostile stored value (bad encoding or
 *  the wrong length) must not throw and crash identity load; the caller treats null as "no
 *  usable stored identity". */
export function keypairFromStoredSecret(encoded: string): RawKeypair | null {
  let secretKey: Uint8Array;
  try {
    secretKey = base64urlnopad.decode(encoded);
  } catch {
    return null;
  }
  if (secretKey.length !== 32) return null;
  try {
    return keypairFromSecret(secretKey);
  } catch {
    return null;
  }
}

/** 32-byte ed25519 public key -> did:key:z6Mk... */
export function publicKeyToDid(publicKey: Uint8Array): string {
  const bytes = new Uint8Array(ED25519_PUB_MULTICODEC.length + publicKey.length);
  bytes.set(ED25519_PUB_MULTICODEC, 0);
  bytes.set(publicKey, ED25519_PUB_MULTICODEC.length);
  return DID_KEY_PREFIX + base58.encode(bytes);
}

/** did:key:z6Mk... -> 32-byte ed25519 public key. Throws if it is not an ed25519 did:key. */
export function didToPublicKey(did: string): Uint8Array {
  if (!did.startsWith(DID_KEY_PREFIX)) {
    throw new Error("not a did:key ed25519 identity");
  }
  const bytes = base58.decode(did.slice(DID_KEY_PREFIX.length));
  if (bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new Error("did:key is not ed25519 (bad multicodec prefix)");
  }
  const key = bytes.slice(2);
  // The multicodec prefix is not enough: a hostile did can carry a short or long body. An
  // ed25519 key is exactly 32 bytes, the same check solanaAddressToPublicKey makes.
  if (key.length !== 32) {
    throw new Error("did:key ed25519 body is not 32 bytes");
  }
  return key;
}

/** 32-byte ed25519 public key -> base58 Solana address (the bare pubkey, no multicodec prefix). */
export function publicKeyToSolanaAddress(publicKey: Uint8Array): string {
  return base58.encode(publicKey);
}

/** base58 Solana address -> 32-byte ed25519 public key. Throws if it is not 32 bytes. */
export function solanaAddressToPublicKey(address: string): Uint8Array {
  const bytes = base58.decode(address);
  if (bytes.length !== 32) {
    throw new Error("not a 32-byte ed25519 Solana address");
  }
  return bytes;
}

/** The Solana address of a did:key ed25519 identity. Same key, base58 of the bare pubkey. */
export function didToSolanaAddress(did: string): string {
  return publicKeyToSolanaAddress(didToPublicKey(did));
}

export function signBytes(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed.sign(message, secretKey);
}

export function verifyBytes(
  sig: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed.verify(sig, message, publicKey);
  } catch {
    return false;
  }
}
