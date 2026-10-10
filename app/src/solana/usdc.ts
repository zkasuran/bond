// USDC transfer builder for Bond payments. Builds an unsigned transaction the connected
// wallet signs and sends through Mobile Wallet Adapter (see wallet.signAndSendTransaction).
// USDC is the payment rail for the marketplace: a human pays another member or an agent
// pays for a skill. The payment is a transferChecked so the mint and decimals are
// asserted on-chain. The recipient token account is created idempotently so a first-time
// receiver does not have to open one first. Defaults to devnet USDC (6 decimals).
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { USDC_DECIMALS, USDC_DEVNET_MINT } from "./config";

/** The on-chain amount type is a u64, so a base-unit amount above this cannot settle. The
 *  ceiling is asserted here rather than left to SPL serialization to reject later. */
export const MAX_U64 = 18_446_744_073_709_551_615n;
/** A sane ceiling on the raw amount string. A u64 is 20 digits, so 32 covers any legal
 *  value with its decimal point while bounding the cost of parsing a hostile long string. */
export const MAX_AMOUNT_INPUT_LEN = 32;

/** Convert a UI amount (like "12.5" USDC) to integer base units. Parsed as a decimal
 *  string so there is no float rounding: 12.5 with 6 decimals is 12500000n. Rejects a
 *  malformed amount, a NaN/Infinity/negative number, an over-long input, more fractional
 *  digits than the mint allows, or a result above the u64 ceiling. */
export function toBaseUnits(uiAmount: number | string, decimals = USDC_DECIMALS): bigint {
  if (typeof uiAmount === "number" && !Number.isFinite(uiAmount)) {
    throw new Error("Amount must be a finite number");
  }
  const s = typeof uiAmount === "number" ? uiAmount.toString() : uiAmount.trim();
  if (s.length > MAX_AMOUNT_INPUT_LEN) {
    throw new Error("Amount is too long");
  }
  if (/[eE]/.test(s)) {
    throw new Error("Pass very small or very large amounts as a decimal string, not a number");
  }
  if (s === "" || s === "." || !/^\d*(\.\d*)?$/.test(s)) {
    throw new Error(`Invalid amount: ${uiAmount}`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    throw new Error(`Amount has more than ${decimals} decimal places`);
  }
  const digits = (whole === "" ? "0" : whole) + frac.padEnd(decimals, "0");
  const base = BigInt(digits);
  if (base > MAX_U64) {
    throw new Error("Amount exceeds the maximum supported value");
  }
  return base;
}

/** Convert integer base units back to a trimmed decimal string. 12500000n at 6 decimals
 *  is "12.5". Trailing zeros are dropped and a whole number has no point. */
export function fromBaseUnits(base: bigint | number | string, decimals = USDC_DECIMALS): string {
  const b = typeof base === "bigint" ? base : BigInt(base);
  const negative = b < 0n;
  const abs = (negative ? -b : b).toString().padStart(decimals + 1, "0");
  const whole = abs.slice(0, abs.length - decimals);
  const frac = abs.slice(abs.length - decimals).replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : whole;
  return negative ? `-${out}` : out;
}

export interface UsdcTransfer {
  /** The unsigned transaction, feePayer and blockhash set, ready for the wallet. */
  transaction: Transaction;
  from: PublicKey;
  to: PublicKey;
  fromTokenAccount: PublicKey;
  toTokenAccount: PublicKey;
  amountBaseUnits: bigint;
  uiAmount: string;
  mint: PublicKey;
  decimals: number;
  lastValidBlockHeight: number;
}

/** Build a USDC transfer of `uiAmount` from `from` to `to`. The returned transaction is
 *  unsigned: hand it to wallet.signAndSendTransaction. `from` pays the fee and any rent
 *  for the recipient token account. */
export async function buildUsdcTransfer(
  connection: Connection,
  from: PublicKey,
  to: PublicKey,
  uiAmount: number | string,
  options: { mint?: PublicKey; decimals?: number } = {},
): Promise<UsdcTransfer> {
  const decimals = options.decimals ?? USDC_DECIMALS;
  const mint = options.mint ?? new PublicKey(USDC_DEVNET_MINT);
  const amountBaseUnits = toBaseUnits(uiAmount, decimals);
  if (amountBaseUnits <= 0n) {
    throw new Error("Transfer amount must be greater than zero");
  }

  const fromTokenAccount = getAssociatedTokenAddressSync(mint, from);
  const toTokenAccount = getAssociatedTokenAddressSync(mint, to);

  const createRecipientAta = createAssociatedTokenAccountIdempotentInstruction(
    from,
    toTokenAccount,
    to,
    mint,
  );
  const transfer = createTransferCheckedInstruction(
    fromTokenAccount,
    mint,
    toTokenAccount,
    from,
    amountBaseUnits,
    decimals,
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const transaction = new Transaction({ feePayer: from, blockhash, lastValidBlockHeight }).add(
    createRecipientAta,
    transfer,
  );

  return {
    transaction,
    from,
    to,
    fromTokenAccount,
    toTokenAccount,
    amountBaseUnits,
    uiAmount: fromBaseUnits(amountBaseUnits, decimals),
    mint,
    decimals,
    lastValidBlockHeight,
  };
}

/** Read an owner's USDC balance. A missing token account means a zero balance, not an
 *  error, so a wallet that has never held USDC still renders cleanly. */
export async function getUsdcBalance(
  connection: Connection,
  owner: PublicKey,
  options: { mint?: PublicKey; decimals?: number } = {},
): Promise<{ amountBaseUnits: bigint; uiAmount: string }> {
  const decimals = options.decimals ?? USDC_DECIMALS;
  const mint = options.mint ?? new PublicKey(USDC_DEVNET_MINT);
  const tokenAccount = getAssociatedTokenAddressSync(mint, owner);
  try {
    const account = await getAccount(connection, tokenAccount);
    return {
      amountBaseUnits: account.amount,
      uiAmount: fromBaseUnits(account.amount, decimals),
    };
  } catch {
    return { amountBaseUnits: 0n, uiAmount: "0" };
  }
}
