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
import { getStreamingFetch } from "../bridge/net";
import { JUPITER_LITE_API } from "./config";
import { fromBaseUnits } from "./usdc";

export const DEFAULT_SLIPPAGE_BPS = 50;

// Ceilings on the two untrusted network calls. A hard timeout stops a hung Jupiter request
// from blocking the UI forever. A hard response-size cap rejects an oversized body before it
// is fully read into memory. The cap is only effective if the body is read as a stream, so
// the Jupiter fetch goes through getStreamingFetch() (expo/fetch on device), which streams on
// native and web. React Native's built-in fetch does not stream, so the bare global fetch
// would force the text() fallback and buffer the whole hostile body first. Named here so the
// limits live in one place (Hardened to ship, point 5). AbortController + setTimeout is used,
// not AbortSignal.timeout, which is not guaranteed on React Native / Hermes.
export const JUPITER_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 1_000_000;
/** Hard ceiling on route-plan steps parsed from a quote, so a hostile quote cannot blow up
 *  the parse with a huge array. */
export const MAX_ROUTE_PLAN_STEPS = 64;
/** Byte bounds for a serialized swap transaction. Solana caps a transaction at 1232 bytes on
 *  the wire, so a legitimate Jupiter swap never exceeds it. A payload outside these bounds is
 *  refused before it is decoded for signing. */
export const MAX_SWAP_TX_BYTES = 1232;
export const MIN_SWAP_TX_BYTES = 64;

/** The declared content-length as a finite non-negative integer. Null when the server did not
 *  declare one (absent, empty or unparseable). A chunked response declares none. */
function declaredContentLength(res: Response): number | null {
  const header = (res as { headers?: { get?: (name: string) => string | null } })?.headers?.get?.(
    "content-length",
  );
  if (header == null || header.trim() === "") return null;
  const len = Number(header);
  return Number.isFinite(len) && len >= 0 ? len : null;
}

/** Early reject when the server volunteers an oversized content-length. This is only a cheap
 *  pre-check: the real enforcement is readCappedBody, which counts the bytes as they stream in
 *  whether or not a length was declared. */
function assertResponseSize(res: Response, label: string): void {
  const len = declaredContentLength(res);
  if (len != null && len > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response too large (${len} bytes)`);
  }
}

/** A promise that rejects the moment a signal aborts. Raced against the body read so a stalled
 *  body cannot outlast the request timeout, even if the platform fetch does not itself reject
 *  an in-flight read on abort. */
function abortRejection(signal: AbortSignal, label: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(`${label} aborted`));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Read the response body with a hard byte cap, regardless of any declared content-length.
 *  Streams and counts bytes when the platform exposes a readable body (the true hard cap,
 *  aborting mid-body the instant the ceiling is crossed). The Jupiter fetch runs through
 *  getStreamingFetch(), so this streaming branch is the path that runs on device. If the body
 *  is not streamable (a non-streaming fetch), text()/json() would buffer the WHOLE body before
 *  it could be measured, so they are never called on an unbounded response: a response that
 *  declares no length over this untrusted path is refused rather than buffered. A declared
 *  length is trusted only up to the cap. */
async function readCappedBody(res: Response, signal: AbortSignal, label: string): Promise<string> {
  const anyRes = res as {
    body?: {
      getReader?: () => {
        read: () => Promise<{ done: boolean; value?: Uint8Array }>;
        cancel?: () => unknown;
      };
    };
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
  };
  if (anyRes.body && typeof anyRes.body.getReader === "function") {
    const reader = anyRes.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abortRejection(signal, label)]);
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          if (typeof reader.cancel === "function") await reader.cancel();
          throw new Error(`${label} response too large (over ${MAX_RESPONSE_BYTES} bytes)`);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  // No streamable body (for example React Native's built-in fetch). Refuse to buffer an
  // unbounded body: require a declared length within the cap before reading anything.
  const declared = declaredContentLength(res);
  if (declared == null) {
    throw new Error(`${label} response declared no length, refusing to buffer the body`);
  }
  if (declared > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response too large (${declared} bytes)`);
  }
  if (typeof anyRes.text === "function") {
    const text = await Promise.race([anyRes.text(), abortRejection(signal, label)]);
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`${label} response too large (over ${MAX_RESPONSE_BYTES} bytes)`);
    }
    return text;
  }
  if (typeof anyRes.json === "function") {
    const data = await Promise.race([anyRes.json(), abortRejection(signal, label)]);
    return JSON.stringify(data ?? null);
  }
  throw new Error(`${label} response has no readable body`);
}

interface LimitedResponse {
  ok: boolean;
  status: number;
  bodyText: string;
}

/** fetch with a hard timeout that covers the response BODY read (not just the headers) plus a
 *  hard byte cap on the body. Combines a caller signal with an internal timeout controller so
 *  either can abort the request. The body is read here, under the live timer, so a server that
 *  sends headers then stalls the body is aborted rather than left to hang the UI. */
async function fetchWithLimits(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  opts: { timeoutMs: number; signal?: AbortSignal; label: string },
): Promise<LimitedResponse> {
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
    // Through the app's streaming fetch (expo/fetch on device), so readCappedBody streams the
    // body and the byte cap is enforced while reading, not after the whole body is buffered.
    const res = await getStreamingFetch()(url, { ...init, signal: controller.signal });
    assertResponseSize(res, opts.label);
    const bodyText = await readCappedBody(res, controller.signal, opts.label);
    return { ok: Boolean(res.ok), status: Number(res.status), bodyText };
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

const INT_STRING = /^\d{1,32}$/;

function isIntString(v: unknown): v is string {
  return typeof v === "string" && INT_STRING.test(v);
}

/** Parse an untrusted amount field into base units without throwing. A non-integer, hostile
 *  or missing value becomes 0n rather than crashing a BigInt conversion on the display path. */
function toIntBaseUnits(v: unknown): bigint {
  if (typeof v === "string" && INT_STRING.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  return 0n;
}

/** Validate a Jupiter quote at the trust boundary. Every field is attacker-controlled when the
 *  response is hostile or malformed, so the required mints and the three amount fields are
 *  checked before the quote is used to summarise a rate or build a swap. Rejects rather than
 *  letting a bad amount reach a BigInt conversion downstream. */
function assertValidQuote(parsed: unknown): JupiterQuote {
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Jupiter quote malformed: not an object");
  }
  const q = parsed as Record<string, unknown>;
  if (typeof q.inputMint !== "string" || q.inputMint.length === 0 || q.inputMint.length > 64) {
    throw new Error("Jupiter quote malformed: inputMint");
  }
  if (typeof q.outputMint !== "string" || q.outputMint.length === 0 || q.outputMint.length > 64) {
    throw new Error("Jupiter quote malformed: outputMint");
  }
  if (!isIntString(q.inAmount)) throw new Error("Jupiter quote malformed: inAmount");
  if (!isIntString(q.outAmount)) throw new Error("Jupiter quote malformed: outAmount");
  if (!isIntString(q.otherAmountThreshold)) {
    throw new Error("Jupiter quote malformed: otherAmountThreshold");
  }
  if (q.routePlan !== undefined) {
    if (!Array.isArray(q.routePlan) || q.routePlan.length > MAX_ROUTE_PLAN_STEPS) {
      throw new Error("Jupiter quote malformed: routePlan");
    }
  }
  return parsed as JupiterQuote;
}

/** Fetch a route quote. Safe to call anywhere: it reads mainnet prices and moves no funds.
 *  Throws with the Jupiter status and body on a non-2xx so the UI can show a real reason.
 *  The parsed body is runtime-validated before it is returned. */
export async function getQuote(params: QuoteParams): Promise<JupiterQuote> {
  const query = buildQuery({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: String(params.slippageBps ?? DEFAULT_SLIPPAGE_BPS),
  });
  const { ok, status, bodyText } = await fetchWithLimits(
    `${JUPITER_LITE_API}/quote?${query}`,
    { headers: { Accept: "application/json" } },
    { timeoutMs: JUPITER_TIMEOUT_MS, signal: params.signal, label: "Jupiter quote" },
  );
  if (!ok) {
    throw new Error(`Jupiter quote failed (${status}): ${bodyText.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error("Jupiter quote returned invalid JSON");
  }
  return assertValidQuote(parsed);
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
  const { ok, status, bodyText } = await fetchWithLimits(
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
  if (!ok) {
    throw new Error(`Jupiter swap build failed (${status}): ${bodyText.slice(0, 200)}`);
  }
  let json: SwapTransactionResult;
  try {
    json = JSON.parse(bodyText) as SwapTransactionResult;
  } catch {
    throw new Error("Jupiter swap build returned invalid JSON");
  }
  if (typeof json.swapTransaction !== "string" || json.swapTransaction.length === 0) {
    throw new Error("Jupiter swap build returned no transaction");
  }
  return {
    swapTransaction: json.swapTransaction,
    lastValidBlockHeight: json.lastValidBlockHeight,
    prioritizationFeeLamports: json.prioritizationFeeLamports,
  };
}

/** What the decoded swap transaction must match: the connected wallet as fee payer and both
 *  mints from the quote the user approved. */
export interface SwapExpectation {
  userPublicKey: string;
  inputMint: string;
  outputMint: string;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validate the base64 swap payload shape and size before any decode, so empty, non-base64 or
 *  absurdly large bytes are refused rather than handed to the deserializer. Returns the decoded
 *  bytes on success. */
export function assertSwapTransactionBytes(
  swapTransactionBase64: unknown,
  label = "Jupiter swap",
): Uint8Array {
  if (typeof swapTransactionBase64 !== "string" || swapTransactionBase64.length === 0) {
    throw new Error(`${label} returned no transaction to sign`);
  }
  if (!BASE64.test(swapTransactionBase64)) {
    throw new Error(`${label} transaction is not valid base64`);
  }
  const bytes = Uint8Array.from(Buffer.from(swapTransactionBase64, "base64"));
  if (bytes.length < MIN_SWAP_TX_BYTES || bytes.length > MAX_SWAP_TX_BYTES) {
    throw new Error(`${label} transaction size out of bounds (${bytes.length} bytes)`);
  }
  return bytes;
}

function accountKeyStrings(tx: unknown): string[] {
  const message = (tx as { message?: { staticAccountKeys?: unknown } } | null | undefined)?.message;
  const keys = (message as { staticAccountKeys?: unknown } | undefined)?.staticAccountKeys;
  if (!Array.isArray(keys)) return [];
  return keys.map((k) => {
    const key = k as { toBase58?: () => string };
    return typeof key?.toBase58 === "function" ? key.toBase58() : String(k);
  });
}

/** Sanity-check a decoded swap transaction against the quote the user approved. Asserts the
 *  fee payer is the connected wallet and that both the quoted input and output mints appear in
 *  the account keys, so a compromised or spoofed Jupiter endpoint cannot slip a transaction
 *  that pays a different fee payer or routes different mints past the signer. Fails closed when
 *  the transaction cannot be inspected rather than trusting unverified bytes. */
export function assertSwapTransactionMatchesQuote<T>(tx: T, expectations: SwapExpectation): T {
  const keys = accountKeyStrings(tx);
  if (keys.length === 0) {
    throw new Error("Swap transaction could not be inspected, refusing to sign unverified bytes");
  }
  if (keys[0] !== expectations.userPublicKey) {
    throw new Error("Swap transaction fee payer does not match the connected wallet");
  }
  if (!keys.includes(expectations.inputMint)) {
    throw new Error("Swap transaction is missing the quoted input mint");
  }
  if (!keys.includes(expectations.outputMint)) {
    throw new Error("Swap transaction is missing the quoted output mint");
  }
  return tx;
}

/** Decode the base64 swap transaction into a VersionedTransaction for MWA signing. The bytes
 *  are shape- and size-checked before decode. When `expectations` are passed the decoded
 *  transaction is also matched against the quote (fee payer and mints) before it is returned
 *  for signing, so hostile bytes are never blindly prepared for signature. */
export function deserializeSwapTransaction(
  swapTransactionBase64: string,
  expectations?: SwapExpectation,
): VersionedTransaction {
  const bytes = assertSwapTransactionBytes(swapTransactionBase64);
  const tx = VersionedTransaction.deserialize(bytes);
  if (expectations) assertSwapTransactionMatchesQuote(tx, expectations);
  return tx;
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
  const inUiAmount = fromBaseUnits(toIntBaseUnits(quote.inAmount), inputDecimals);
  const outUiAmount = fromBaseUnits(toIntBaseUnits(quote.outAmount), outputDecimals);
  const minReceivedUiAmount = fromBaseUnits(
    toIntBaseUnits(quote.otherAmountThreshold),
    outputDecimals,
  );
  const inNumber = Number(inUiAmount);
  const outNumber = Number(outUiAmount);
  const priceImpact = Number(quote.priceImpactPct ?? 0);
  const slippage = Number(quote.slippageBps);
  const route = Array.isArray(quote.routePlan)
    ? quote.routePlan.map((step) => step?.swapInfo?.label ?? step?.swapInfo?.ammKey ?? "")
    : [];
  return {
    inUiAmount,
    outUiAmount,
    minReceivedUiAmount,
    priceImpactPct: Number.isFinite(priceImpact) ? priceImpact : 0,
    slippageBps: Number.isFinite(slippage) ? slippage : 0,
    rate: inNumber > 0 && Number.isFinite(outNumber) ? outNumber / inNumber : 0,
    route,
  };
}
