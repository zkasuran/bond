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
import { solanaAddressToPublicKey, verifyBytes } from "../identity/keys";
import type { WalletConnection } from "./wallet";

const utf8 = new TextEncoder();
const BINDING_KEY_PREFIX = "bond.walletBinding.";

export interface BindingChallenge {
  /** The device did:key being bound. */
  did: string;
  /** base58 Solana address of the wallet doing the binding. */
  walletAddress: string;
  /** Random per-binding value so a signature cannot be replayed for a new binding. */
  nonce: string;
  /** ISO 8601 timestamp the challenge was issued. */
  issuedAt: string;
}

export interface WalletBinding extends BindingChallenge {
  /** base64url Ed25519 signature by the wallet over the challenge message. */
  signature: string;
  boundAt: string;
}

/** The exact human-readable text the wallet signs. Deterministic from the challenge so a
 *  verifier rebuilds the same bytes. The wallet shows this to the user at signing time. */
export function buildBindingMessage(challenge: BindingChallenge): string {
  return [
    "Bond wallet binding v1",
    `did: ${challenge.did}`,
    `wallet: ${challenge.walletAddress}`,
    `nonce: ${challenge.nonce}`,
    `issued: ${challenge.issuedAt}`,
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

/** Verify a wallet signature over a challenge against the wallet's own address. Returns
 *  false rather than throwing on a bad address or a signature that does not check out. */
export function verifyBinding(challenge: BindingChallenge, signature: Uint8Array): boolean {
  try {
    const publicKey = solanaAddressToPublicKey(challenge.walletAddress);
    return verifyBytes(signature, bindingMessageBytes(challenge), publicKey);
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
function bindingKey(did: string): string {
  return BINDING_KEY_PREFIX + did.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function saveBinding(binding: WalletBinding): Promise<void> {
  await SecureStore.setItemAsync(bindingKey(binding.did), JSON.stringify(binding));
}

export async function loadBinding(did: string): Promise<WalletBinding | null> {
  const raw = await SecureStore.getItemAsync(bindingKey(did));
  return raw ? (JSON.parse(raw) as WalletBinding) : null;
}

export async function clearBinding(did: string): Promise<void> {
  await SecureStore.deleteItemAsync(bindingKey(did));
}

export async function isWalletBound(did: string): Promise<boolean> {
  return (await loadBinding(did)) !== null;
}

/** Bind the connected wallet to the device did:key. Signs a fresh challenge with the wallet,
 *  verifies the signature against the wallet address, stores the binding and returns it.
 *  Android-only via the dynamic wallet import. Pass an existing connection to skip a second
 *  authorize prompt. Throws if the signature does not verify. */
export async function bindWalletToIdentity(
  did: string,
  connection?: WalletConnection,
): Promise<WalletBinding> {
  const wallet = await import("./wallet");
  const conn = connection ?? (await wallet.connectWallet());
  const challenge: BindingChallenge = {
    did,
    walletAddress: conn.address,
    nonce: randomNonce(),
    issuedAt: new Date().toISOString(),
  };
  const signedPayload = await wallet.signMessage(bindingMessageBytes(challenge), {
    authToken: conn.authToken,
    addressBase64: conn.addressBase64,
  });
  const signature = extractSignature(signedPayload);
  if (!verifyBinding(challenge, signature)) {
    throw new Error("Wallet signature did not verify against the connected address");
  }
  const binding: WalletBinding = {
    ...challenge,
    signature: base64urlnopad.encode(signature),
    boundAt: new Date().toISOString(),
  };
  await saveBinding(binding);
  return binding;
}
