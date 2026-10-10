// On-chain confirmation for a submitted transfer. A signature from the wallet means the
// transaction was handed to the cluster, not that it landed, so the payment flow waits for
// this before it ever shows "confirmed". Kept out of usdc.ts so a caller can confirm any
// signature it holds. The Connection type is imported type-only, so this module pulls no
// web3.js runtime into a bundle that only wants the helper's signature.
import type { Connection, Commitment } from "@solana/web3.js";

export interface BlockhashContext {
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Wall-clock ceiling for the whole confirmation, across every retry. A stalled or
 *  unresponsive RPC can never leave the payment UI hanging on "confirming" past this. */
export const CONFIRM_TIMEOUT_MS = 60_000;
/** Bounded retries on a transient failure (a thrown RPC error or a per-attempt timeout).
 *  A transaction the cluster reports as failed is never retried. */
export const CONFIRM_MAX_ATTEMPTS = 3;
/** Pause between retries, itself bounded by the wall-clock deadline. */
export const CONFIRM_RETRY_DELAY_MS = 1_500;

/** The cluster reported the transaction itself failed. Not retryable: the transfer did not
 *  execute, so a caller must never record it as confirmed. */
export class TransferFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferFailedError";
  }
}

/** The transaction confirmed on-chain but does not match the payment it was presented as: a
 *  wrong amount, mint, sender or recipient. Not retryable: a bare confirmed signature proves
 *  execution, never that it moved the claimed funds between the claimed parties. */
export class PaymentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentMismatchError";
  }
}

/** The transfer a confirmed signature is expected to carry. When passed to confirmSignature
 *  the fetched transaction is checked against it, so a confirmed-but-unrelated signature
 *  (a tiny self-send, any other confirmed tx) can never pass as the claimed payment. */
export interface ExpectedTransfer {
  /** Amount in base units, as an integer string. */
  amount: string;
  /** SPL mint address that must have moved. */
  mint: string;
  /** Owner wallet of the sender. */
  from: string;
  /** Owner wallet of the recipient. */
  to: string;
}

/** Positively assert the web3.js RpcResponseAndContext<SignatureResult> success shape rather
 *  than trusting a falsy `err`. A malformed or proxied body ({}, { value: null }, a result
 *  with no `err` key) is not a confirmation. Success is an explicit `err === null`. */
function isConfirmed(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = (result as { value?: unknown }).value;
  if (!value || typeof value !== "object" || !("err" in value)) return false;
  return (value as { err: unknown }).err === null;
}

/** A result that explicitly carries a non-null execution error: the transaction failed. */
function executionError(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const value = (result as { value?: unknown }).value;
  if (!value || typeof value !== "object" || !("err" in value)) return undefined;
  const err = (value as { err: unknown }).err;
  return err === null ? undefined : err;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParsedTokenBalance {
  mint?: unknown;
  owner?: unknown;
  uiTokenAmount?: { amount?: unknown };
}

/** Sum the token balance a given owner holds of a given mint across a pre/post balance list.
 *  Returns undefined when the owner holds no entry for that mint, so a missing side reads as
 *  "did not take part" rather than zero. Rejects a non-numeric amount by returning undefined,
 *  so a malformed balance can never satisfy a match. */
function sumOwnerMint(list: unknown, owner: string, mint: string): bigint | undefined {
  if (!Array.isArray(list)) return undefined;
  let total = 0n;
  let found = false;
  for (const entry of list as ParsedTokenBalance[]) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.owner !== owner || entry.mint !== mint) continue;
    const raw = entry.uiTokenAmount?.amount;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
    total += BigInt(raw);
    found = true;
  }
  return found ? total : undefined;
}

/** Positively assert that a fetched, confirmed transaction actually moved `expected.amount`
 *  of `expected.mint` from `expected.from` to `expected.to`. Reads the token balance deltas
 *  (the canonical SPL record of who received what) rather than trusting the receipt payload.
 *  Returns false on any shape it cannot positively match, so verification fails closed. */
function transferMatches(tx: unknown, expected: ExpectedTransfer): boolean {
  if (typeof expected.amount !== "string" || !/^\d+$/.test(expected.amount)) return false;
  const amount = BigInt(expected.amount);
  if (amount <= 0n) return false;
  if (!tx || typeof tx !== "object") return false;
  const meta = (tx as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") return false;
  if ((meta as { err?: unknown }).err != null) return false;
  const pre = (meta as { preTokenBalances?: unknown }).preTokenBalances;
  const post = (meta as { postTokenBalances?: unknown }).postTokenBalances;

  // The recipient must have received exactly `amount` of the mint.
  const toPre = sumOwnerMint(pre, expected.to, expected.mint) ?? 0n;
  const toPost = sumOwnerMint(post, expected.to, expected.mint);
  if (toPost === undefined || toPost - toPre !== amount) return false;

  // The sender must have sent exactly `amount` of the mint.
  const fromPre = sumOwnerMint(pre, expected.from, expected.mint);
  const fromPost = sumOwnerMint(post, expected.from, expected.mint) ?? 0n;
  if (fromPre === undefined || fromPre - fromPost !== amount) return false;

  return true;
}

async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wait for `signature` to confirm against the blockhash it was built on. Resolves the
 *  signature only when the cluster reports the transaction succeeded (an explicit null
 *  error). Throws a TransferFailedError when it reports a failure, and throws rather than
 *  hangs when the RPC stalls: a per-attempt and overall wall-clock timeout bounds the wait
 *  and a bounded retry covers a transient RPC error. When `options.expected` is supplied the
 *  confirmed transaction is fetched and its token balance deltas are matched against the
 *  claimed amount, mint, sender and recipient, so a confirmed-but-unrelated signature is
 *  rejected (PaymentMismatchError). A caller never records a failed, never-confirming,
 *  unexpectedly-shaped or mismatched result as a confirmed transfer. */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  ctx: BlockhashContext,
  commitment: Commitment = "confirmed",
  options: {
    timeoutMs?: number;
    maxAttempts?: number;
    retryDelayMs?: number;
    expected?: ExpectedTransfer;
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? CONFIRM_MAX_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? CONFIRM_RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: Error = new Error("Transfer did not confirm on-chain within the timeout");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const result = await withDeadline(
        connection.confirmTransaction(
          { signature, blockhash: ctx.blockhash, lastValidBlockHeight: ctx.lastValidBlockHeight },
          commitment,
        ),
        remaining,
        "Confirmation timed out waiting for the cluster",
      );
      const err = executionError(result);
      if (err !== undefined) {
        throw new TransferFailedError(`Transfer did not confirm on-chain: ${JSON.stringify(err)}`);
      }
      if (isConfirmed(result)) {
        if (options.expected) await assertExpectedTransfer(connection, signature, commitment, options.expected, deadline);
        return signature;
      }
      // A value was returned but it is neither a confirmed success nor a reported failure, so
      // the shape is unexpected. Do not read the absence of an error as a confirmation.
      lastError = new Error(
        "Confirmation returned an unexpected response, not treating the transfer as confirmed",
      );
    } catch (e) {
      if (e instanceof TransferFailedError) throw e; // a real failure is never retried
      if (e instanceof PaymentMismatchError) throw e; // a wrong transfer is never retried
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    if (attempt < maxAttempts && Date.now() + retryDelayMs < deadline) {
      await delay(retryDelayMs);
    }
  }
  throw lastError;
}

/** Fetch the confirmed transaction and assert it carries the claimed transfer. A field
 *  mismatch is a hard PaymentMismatchError (never retried). A transaction that cannot be
 *  fetched yet throws a plain error so the caller's bounded retry can try again, and if the
 *  deadline passes without a match the transfer is rejected: verification fails closed. */
async function assertExpectedTransfer(
  connection: Connection,
  signature: string,
  commitment: Commitment,
  expected: ExpectedTransfer,
  deadline: number,
): Promise<void> {
  const parsed = await withDeadline(
    connection.getParsedTransaction(signature, {
      commitment: commitment === "finalized" ? "finalized" : "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
    Math.max(0, deadline - Date.now()),
    "Fetching the transaction to verify the transfer timed out",
  );
  if (!parsed) {
    throw new Error("Confirmed transaction is not available yet to verify the transfer");
  }
  if (!transferMatches(parsed, expected)) {
    throw new PaymentMismatchError(
      "The confirmed transaction does not match the expected amount, mint, sender or recipient",
    );
  }
}
