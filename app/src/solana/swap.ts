// Jupiter swap client. Quotes are a plain GET and work anywhere, so Bond always shows a
// live rate. Execution is different: Jupiter is MAINNET-ONLY and building a swap needs a
// real funded wallet, so the swap transaction is only ever signed behind an explicit,
// funded, user-approved action. The UI shows the quote for free and gates the send.
//
// Endpoints are the free lite-api tier. The quote response is passed back verbatim as
// `quoteResponse` when building the transaction, so JupiterQuote keeps an index signature
// rather than dropping fields the /swap endpoint needs.
import { VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { JUPITER_LITE_API } from "./config";
import { fromBaseUnits } from "./usdc";

export const DEFAULT_SLIPPAGE_BPS = 50;

// Ceilings on the two untrusted network calls. A hard timeout stops a hung Jupiter request
// from blocking the UI forever. A declared response-size cap rejects an absurd body before
// it is read into memory. Named here so the limits live in one place (Hardened to ship,
// point 5). AbortController + setTimeout is used, not AbortSignal.timeout, which is not
// guaranteed on React Native / Hermes.
export const JUPITER_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 1_000_000;

function assertResponseSize(res: Response, label: string): void {
  const header = (res as { headers?: { get?: (name: string) => string | null } })?.headers?.get?.(
    "content-length",
  );
  if (header != null) {
    const len = Number(header);
    if (Number.isFinite(len) && len > MAX_RESPONSE_BYTES) {
      throw new Error(`${label} response too large (${len} bytes)`);
    }
  }
}

/** fetch with a hard timeout and a declared response-size cap. Combines a caller signal with
 *  an internal timeout controller so either can abort the request. */
async function fetchWithLimits(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opts: { timeoutMs: number; signal?: AbortSignal; label: string },
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const external = opts.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onAbort);
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    assertResponseSize(res, opts.label);
    return res;
  } catch (e) {
    if (timedOut) {
      throw new Error(`${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener("abort", onAbort);
  }
}

export interface JupiterRoutePlanStep {
  swapInfo: {
    ammKey: string;
    label?: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
  };
  percent: number;
}

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRoutePlanStep[];
  contextSlot?: number;
  [key: string]: unknown;
}

export interface QuoteParams {
  /** Base58 mint of the token being sold. */
  inputMint: string;
  /** Base58 mint of the token being bought. */
  outputMint: string;
  /** Amount of inputMint in base units (an integer, as string, number or bigint). */
  amount: string | number | bigint;
  slippageBps?: number;
  signal?: AbortSignal;
}

function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** Fetch a route quote. Safe to call anywhere: it reads mainnet prices and moves no funds.
 *  Throws with the Jupiter status and body on a non-2xx so the UI can show a real reason. */
export async function getQuote(params: QuoteParams): Promise<JupiterQuote> {
  const query = buildQuery({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: String(params.slippageBps ?? DEFAULT_SLIPPAGE_BPS),
  });
  const res = await fetchWithLimits(
    `${JUPITER_LITE_API}/quote?${query}`,
    { headers: { Accept: "application/json" } },
    { timeoutMs: JUPITER_TIMEOUT_MS, signal: params.signal, label: "Jupiter quote" },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Jupiter quote failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as JupiterQuote;
}

export interface SwapTransactionResult {
  /** A base64 VersionedTransaction, ready for wallet.signAndSendTransaction after decode. */
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

/** Build the swap transaction for a quote. This is the mainnet-only, funds-moving step, so
 *  callers gate it behind an explicit user action. Returns the base64 transaction to sign. */
export async function getSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string,
  options: { wrapAndUnwrapSol?: boolean; signal?: AbortSignal } = {},
): Promise<SwapTransactionResult> {
  const res = await fetchWithLimits(
    `${JUPITER_LITE_API}/swap`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: options.wrapAndUnwrapSol ?? true,
        dynamicComputeUnitLimit: true,
      }),
    },
    { timeoutMs: JUPITER_TIMEOUT_MS, signal: options.signal, label: "Jupiter swap build" },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Jupiter swap build failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as SwapTransactionResult;
  return {
    swapTransaction: json.swapTransaction,
    lastValidBlockHeight: json.lastValidBlockHeight,
    prioritizationFeeLamports: json.prioritizationFeeLamports,
  };
}

/** Decode the base64 swap transaction into a VersionedTransaction for MWA signing. */
export function deserializeSwapTransaction(swapTransactionBase64: string): VersionedTransaction {
  const bytes = Uint8Array.from(Buffer.from(swapTransactionBase64, "base64"));
  return VersionedTransaction.deserialize(bytes);
}

export interface QuoteSummary {
  inUiAmount: string;
  outUiAmount: string;
  minReceivedUiAmount: string;
  priceImpactPct: number;
  slippageBps: number;
  /** Output tokens per input token, for a human-readable rate line. */
  rate: number;
  /** AMM labels along the route, best-effort for display. */
  route: string[];
}

/** Turn a raw quote into display values, converting base units with the two token
 *  decimals. Pure, so the UI and the tests share one formatting path. */
export function summarizeQuote(
  quote: JupiterQuote,
  inputDecimals: number,
  outputDecimals: number,
): QuoteSummary {
  const inUiAmount = fromBaseUnits(BigInt(quote.inAmount), inputDecimals);
  const outUiAmount = fromBaseUnits(BigInt(quote.outAmount), outputDecimals);
  const minReceivedUiAmount = fromBaseUnits(BigInt(quote.otherAmountThreshold), outputDecimals);
  const inNumber = Number(inUiAmount);
  const outNumber = Number(outUiAmount);
  return {
    inUiAmount,
    outUiAmount,
    minReceivedUiAmount,
    priceImpactPct: Number(quote.priceImpactPct ?? 0),
    slippageBps: quote.slippageBps,
    rate: inNumber > 0 ? outNumber / inNumber : 0,
    route: (quote.routePlan ?? []).map((step) => step.swapInfo.label ?? step.swapInfo.ammKey),
  };
}
