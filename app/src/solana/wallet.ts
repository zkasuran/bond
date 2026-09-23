// Mobile Wallet Adapter client. This is the only Bond module that talks to a Seeker or
// other Android wallet, so it is guarded twice: Platform.OS must be "android" and the
// native MWA module is loaded with a dynamic import inside each call. That keeps the web
// bundle and the jest suite from ever resolving the native package. Anything that calls
// these functions off Android gets a clear "wallet is Android-only" error rather than a
// cryptic module-not-found at import time.
//
// The connected wallet is the displayed identity and the USDC payer/recipient. The device
// did:key keeps signing messages (see identity/sign.ts); binding.ts ties the two together
// with a one-time signed challenge, because MWA prompts the user on every signature so
// per-message wallet signing is not viable.
import { Platform } from "react-native";
import { Buffer } from "buffer";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { publicKeyToSolanaAddress } from "../identity/keys";
import { APP_IDENTITY, MWA_CHAIN } from "./config";

/** An authorized wallet session. `address` is the public base58 Solana address; keep
 *  `addressBase64` because MWA signMessages addresses by its own base64 form. */
export interface WalletConnection {
  address: string;
  addressBase64: string;
  authToken: string;
  label?: string;
  walletUriBase?: string;
}

/** True only where a Mobile Wallet Adapter wallet can run. iOS, web and jest are false. */
export function isWalletAvailable(): boolean {
  return Platform.OS === "android";
}

function assertAndroid(): void {
  if (!isWalletAvailable()) {
    throw new Error("Wallet is Android-only. Connect a Seeker wallet on an Android device.");
  }
}

// Dynamic import so neither the web bundle nor jest resolves the native module at load.
async function loadTransact() {
  const mod = await import("@solana-mobile/mobile-wallet-adapter-protocol-web3js");
  return mod.transact;
}

type AuthorizationResultLike = {
  accounts: ReadonlyArray<{ address: string; label?: string }>;
  auth_token: string;
  wallet_uri_base?: string;
};

function toConnection(result: AuthorizationResultLike): WalletConnection {
  const account = result.accounts[0];
  if (!account) throw new Error("Wallet returned no account");
  const bytes = Uint8Array.from(Buffer.from(account.address, "base64"));
  return {
    address: publicKeyToSolanaAddress(bytes),
    addressBase64: account.address,
    authToken: result.auth_token,
    label: "label" in account ? account.label : undefined,
    walletUriBase: result.wallet_uri_base,
  };
}

/** Authorize Bond with the wallet and return the connected account plus an auth token.
 *  The token is cached by the caller (store.ts) and replayed via reauthorize so the user
 *  is not asked to pick an account on every action. */
export async function connectWallet(): Promise<WalletConnection> {
  assertAndroid();
  const transact = await loadTransact();
  return transact(async (wallet) => {
    const result = await wallet.authorize({ chain: MWA_CHAIN, identity: APP_IDENTITY });
    return toConnection(result as AuthorizationResultLike);
  });
}

/** Refresh a cached authorization. Returns the account the token now maps to, which may
 *  differ if the user switched accounts in the wallet. */
export async function reauthorize(authToken: string): Promise<WalletConnection> {
  assertAndroid();
  const transact = await loadTransact();
  return transact(async (wallet) => {
    const result = await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY });
    return toConnection(result as AuthorizationResultLike);
  });
}

/** Revoke the auth token. A no-op off Android so callers can call it unconditionally. */
export async function disconnectWallet(authToken: string): Promise<void> {
  if (!isWalletAvailable()) return;
  const transact = await loadTransact();
  await transact(async (wallet) => {
    await wallet.deauthorize({ auth_token: authToken });
  });
}

/** Sign an arbitrary message with the connected wallet. Reauthorizes inside the same MWA
 *  session first, which is required before any privileged call. Returns the raw signed
 *  payload the wallet produced (see binding.extractSignature for the signature bytes). */
export async function signMessage(
  message: Uint8Array,
  ctx: { authToken: string; addressBase64: string },
): Promise<Uint8Array> {
  assertAndroid();
  const transact = await loadTransact();
  return transact(async (wallet) => {
    await wallet.reauthorize({ auth_token: ctx.authToken, identity: APP_IDENTITY });
    const signed = await wallet.signMessages({
      addresses: [ctx.addressBase64],
      payloads: [message],
    });
    return signed[0];
  });
}

/** Sign and submit a transaction through the wallet. The wallet holds the key and relays
 *  the transaction to the cluster, returning the base58 signature. Accepts both legacy and
 *  versioned transactions (usdc.ts builds legacy, swap.ts builds versioned). */
export async function signAndSendTransaction(
  tx: Transaction | VersionedTransaction,
  ctx: { authToken: string; minContextSlot?: number },
): Promise<string> {
  assertAndroid();
  const transact = await loadTransact();
  return transact(async (wallet) => {
    await wallet.reauthorize({ auth_token: ctx.authToken, identity: APP_IDENTITY });
    const signatures = await wallet.signAndSendTransactions({
      transactions: [tx],
      minContextSlot: ctx.minContextSlot,
    });
    return signatures[0];
  });
}
