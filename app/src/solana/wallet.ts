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
  accounts: readonly { address: string; label?: string }[];
  auth_token: string;
  wallet_uri_base?: string;
};

function toConnection(result: AuthorizationResultLike): WalletConnection {
  const account = result.accounts[0];
  if (!account) throw new Error("Wallet returned no account");
  const bytes = Uint8Array.from(Buffer.from(account.address, "base64"));
  // A Solana account is a 32-byte ed25519 public key. Reject anything else here rather than
  // base58-encoding a wrong-length blob into a bogus "address" that only fails deep in a
  // later transfer build, after it has been stored and shown as the user.
  if (bytes.length !== 32) {
    throw new Error("Wallet returned an address that is not a 32-byte ed25519 public key");
  }
  return {
    address: publicKeyToSolanaAddress(bytes),
    addressBase64: account.address,
    authToken: result.auth_token,
    label: "label" in account ? account.label : undefined,
    walletUriBase: result.wallet_uri_base,
  };
}

type MwaWalletLike = {
  authorize: (p: { chain: string; identity: typeof APP_IDENTITY }) => Promise<unknown>;
  reauthorize: (p: { auth_token: string; identity: typeof APP_IDENTITY }) => Promise<unknown>;
};

// Called whenever a privileged call had to fall back to a fresh authorize, so the store can
// replace the dead token it holds. Set by solana/store.ts; a no-op until then.
let onSessionRenewed: (conn: WalletConnection) => void = () => {};
export function setSessionRenewedListener(fn: (conn: WalletConnection) => void): void {
  onSessionRenewed = fn;
}

/** Thrown when a reauthorize or fallback authorize resolves to a different wallet account
 *  than the one the pending action was built for. The caller must rebuild against the
 *  current account rather than send a transaction to an account the user did not approve. */
export class WalletAccountChangedError extends Error {
  readonly expectedAddress: string;
  readonly actualAddress: string;
  constructor(expectedAddress: string, actualAddress: string) {
    super("Wallet account changed. Reconnect and rebuild this action for the current account.");
    this.name = "WalletAccountChangedError";
    this.expectedAddress = expectedAddress;
    this.actualAddress = actualAddress;
  }
}

/** True only for the specific condition the reauthorize fallback is meant to handle: the
 *  wallet revoked or expired the cached auth token (MWA error -1, "authorization request
 *  failed"). A user cancel, a network blip or a wallet-busy error returns false so it is
 *  rethrown instead of being escalated into a fresh account-selection prompt. */
export function isAuthTokenInvalidError(e: unknown): boolean {
  if ((e as { code?: unknown })?.code === -1) return true;
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  return (
    msg.includes("authorization request failed") ||
    msg.includes("auth_token") ||
    msg.includes("token expired") ||
    msg.includes("token revoked") ||
    msg.includes("reauthorize failed")
  );
}

/** Inside one MWA session: replay the cached token, and only when the wallet has revoked or
 *  expired it ask for a fresh authorization instead of failing the user's action. When
 *  `expectedAddress` is given, a resolved account that differs from it aborts with a
 *  WalletAccountChangedError and is never adopted: an action built for one account must not
 *  be signed or sent by another. The wallet shows its approve sheet once on a real fallback. */
export async function reauthorizeOrAuthorize(
  wallet: MwaWalletLike,
  authToken: string,
  expectedAddress?: string,
): Promise<WalletConnection> {
  let conn: WalletConnection;
  try {
    conn = toConnection((await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY })) as AuthorizationResultLike);
    if (expectedAddress && conn.address !== expectedAddress) {
      throw new WalletAccountChangedError(expectedAddress, conn.address);
    }
    return conn;
  } catch (e) {
    if (e instanceof WalletAccountChangedError) throw e;
    // Only a revoked or expired token escalates to a fresh authorize. Anything else
    // (user cancel, transient wallet error) propagates with its original message.
    if (!isAuthTokenInvalidError(e)) throw e;
    conn = toConnection((await wallet.authorize({ chain: MWA_CHAIN, identity: APP_IDENTITY })) as AuthorizationResultLike);
    if (expectedAddress && conn.address !== expectedAddress) {
      // Do not adopt a different account for an action built against the old one.
      throw new WalletAccountChangedError(expectedAddress, conn.address);
    }
    onSessionRenewed(conn);
    return conn;
  }
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

/** The base58 account that must sign a transaction: the explicit feePayer on a legacy
 *  Transaction, else the first static account key on a versioned one. Null when it cannot be
 *  read, in which case there is no approved account to compare against. */
function transactionFeePayer(tx: Transaction | VersionedTransaction): string | null {
  const legacyFeePayer = (tx as Transaction).feePayer;
  if (legacyFeePayer && typeof legacyFeePayer.toBase58 === "function") return legacyFeePayer.toBase58();
  const message = (tx as VersionedTransaction).message as
    | { staticAccountKeys?: { toBase58(): string }[] }
    | undefined;
  const first = message?.staticAccountKeys?.[0];
  return first && typeof first.toBase58 === "function" ? first.toBase58() : null;
}

/** Sign an arbitrary message with the connected wallet. Reauthorizes inside the same MWA
 *  session first, which is required before any privileged call. The account that comes back
 *  must still be the one the message is addressed to, else the call aborts rather than let a
 *  different account sign. Returns the raw signed payload (see binding.extractSignature). */
export async function signMessage(
  message: Uint8Array,
  ctx: { authToken: string; addressBase64: string },
): Promise<Uint8Array> {
  assertAndroid();
  const expected = publicKeyToSolanaAddress(Uint8Array.from(Buffer.from(ctx.addressBase64, "base64")));
  const transact = await loadTransact();
  return transact(async (wallet) => {
    const conn = await reauthorizeOrAuthorize(wallet as unknown as MwaWalletLike, ctx.authToken, expected);
    const signed = await wallet.signMessages({
      addresses: [conn.addressBase64],
      payloads: [message],
    });
    return signed[0];
  });
}

/** Sign and submit a transaction through the wallet. The wallet holds the key and relays
 *  the transaction to the cluster, returning the base58 signature. Accepts both legacy and
 *  versioned transactions (usdc.ts builds legacy, swap.ts builds versioned). The reauthorized
 *  account must equal the transaction fee payer, so a revoked-token fallback that lands on a
 *  different account can never send an action the user built for the original account. Fails
 *  closed when the fee payer cannot be read: with no approved account to compare the signing
 *  account against, the transaction is refused rather than sent unguarded. */
export async function signAndSendTransaction(
  tx: Transaction | VersionedTransaction,
  ctx: { authToken: string; minContextSlot?: number },
): Promise<string> {
  assertAndroid();
  const feePayer = transactionFeePayer(tx);
  if (!feePayer) {
    // An indeterminate fee payer leaves no approved account to check the reauthorized signer
    // against, so the account-swap guard below could not fire. Refuse rather than submit a
    // transaction whose signing account cannot be confirmed as the approved one.
    throw new Error(
      "Cannot determine the transaction fee payer, so the signing account cannot be confirmed against the approved account. Refusing to send this transaction.",
    );
  }
  const transact = await loadTransact();
  return transact(async (wallet) => {
    const conn = await reauthorizeOrAuthorize(wallet as unknown as MwaWalletLike, ctx.authToken, feePayer);
    if (conn.address !== feePayer) {
      throw new WalletAccountChangedError(feePayer, conn.address);
    }
    const signatures = await wallet.signAndSendTransactions({
      transactions: [tx],
      minContextSlot: ctx.minContextSlot,
    });
    return signatures[0];
  });
}
