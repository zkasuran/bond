// SKR touchpoint. READ-ONLY. SKR is Seeker's token on Solana mainnet, a classic SPL Token
// at 6 decimals that does not exist on devnet. This module only READS it: a wallet's SKR
// balance and a live USDC to SKR price from Jupiter, the same mainnet read class as the swap
// quote the Wallet screen already shows. Nothing here builds, signs or sends a transaction.
// No SKR is moved. Skill purchases still settle in devnet USDC; SKR only unlocks a bounded
// holder discount on that devnet-USDC price.
//
// It composes what already exists rather than reinventing it: the mainnet connection helper
// from config, getUsdcBalance for the balance (SKR is a plain SPL token so the same reader
// works), plus getQuote/summarizeQuote for the price, so the swap client's fetch timeout and
// response-size ceiling cover the one network call here too.
import { PublicKey } from "@solana/web3.js";
import {
  getConnection,
  SKR_DECIMALS,
  SKR_MINT,
  USDC_DECIMALS,
  USDC_MAINNET_MINT,
} from "./config";
import { fromBaseUnits, getUsdcBalance, toBaseUnits } from "./usdc";
import { getQuote, summarizeQuote } from "./swap";

/** Reference USDC amount, in base units, used to price SKR. 1 USDC at 6 decimals. A fixed
 *  reference keeps the quote stable and comparable between reads. */
export const SKR_PRICE_REFERENCE_USDC_BASE = 1_000_000n;

/** Hard ceiling on the SKR holder discount a creator can set, in basis points. The perk is
 *  bounded so a listing can never zero out a sale: 2500 bps = 25% off at most. */
export const MAX_SKR_HOLDER_DISCOUNT_BPS = 2500;

/** The SKR holder discount a creator gets when they set none of their own, in basis points.
 *  1000 bps = 10% off the devnet-USDC price for a wallet that holds SKR. */
export const DEFAULT_SKR_HOLDER_DISCOUNT_BPS = 1000;

/** Honesty label shown with the holder badge and the discount. The badge and the discount are
 *  derived from a client-side mainnet balance READ, not a signed attestation. A self-custody
 *  client is attacker-controlled, so this value is display-only: the authoritative check is the
 *  on-chain USDC transfer at settlement, which can be re-verified against the cluster. The UI
 *  shows this string so a user is never told the discount is proven when it is only read. */
export const SKR_HOLDER_DISCLOSURE =
  "Holder status is read from this device, not an attestation. The discount is applied for display and the sale settles in USDC on-chain.";

const BPS_DENOMINATOR = 10_000n;

/** SKR holder discounts the sample skill creators have set, in basis points, keyed by skill
 *  id. Each is clamped to MAX_SKR_HOLDER_DISCOUNT_BPS when it is applied, so a listing that
 *  asks for more than the ceiling still only ever grants the ceiling. A skill absent here
 *  falls back to the house default. */
export const CREATOR_SKR_HOLDER_DISCOUNT_BPS: Record<string, number> = {
  "usdc-price-watcher": 1500,
  "wallet-summarizer": 2000,
  "tx-explainer": 500,
};

/** The creator-set SKR holder discount for a skill id, in basis points, before the holder
 *  check and before clamping. Falls back to the house default when the creator set none. */
export function creatorSkrDiscountBps(skillId: string): number {
  const set = CREATOR_SKR_HOLDER_DISCOUNT_BPS[skillId];
  return set == null ? DEFAULT_SKR_HOLDER_DISCOUNT_BPS : set;
}

export interface SkrTouchpoint {
  /** The wallet's SKR balance as a trimmed decimal string. "0" when no SKR account exists. */
  skrBalanceUi: string;
  /** Price of one SKR in USDC, from a live mainnet USDC to SKR quote. 0 when unavailable. */
  skrPriceInUsdc: number;
  /** True when the wallet holds any SKR. Derived from a client read, not an attestation. */
  isHolder: boolean;
  /** Honesty label (SKR_HOLDER_DISCLOSURE): the badge and discount are a client read, not a
   *  proof. The UI shows this beside the badge. */
  holderDisclosure: string;
}

/** Read a wallet's SKR balance and a live SKR price in one pass. Mainnet, read-only: it
 *  composes a mainnet connection with the shared getUsdcBalance (a missing token account
 *  reads as 0, not an error) and the shared Jupiter quote. No transaction is built or signed.
 *  The price fetch is resilient: if Jupiter is unavailable the price comes back 0 so a holder
 *  still sees their balance and the perk still gates on the balance, not on the price feed. */
export async function readSkrTouchpoint(
  ownerAddress: string | null | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<SkrTouchpoint> {
  const connection = getConnection("mainnet-beta");

  let skrBalanceUi = "0";
  let isHolder = false;
  if (ownerAddress) {
    try {
      const owner = new PublicKey(ownerAddress);
      const bal = await getUsdcBalance(connection, owner, {
        mint: new PublicKey(SKR_MINT),
        decimals: SKR_DECIMALS,
      });
      skrBalanceUi = bal.uiAmount;
      isHolder = bal.amountBaseUnits > 0n;
    } catch {
      // A malformed owner address (bad base58 or wrong length) or any read error degrades to
      // a safe non-holder rather than throwing out of the whole touchpoint. isHolder stays
      // false, so a bad address never earns a discount.
      skrBalanceUi = "0";
      isHolder = false;
    }
  }

  let skrPriceInUsdc = 0;
  try {
    const raw = await getQuote({
      inputMint: USDC_MAINNET_MINT,
      outputMint: SKR_MINT,
      amount: SKR_PRICE_REFERENCE_USDC_BASE,
      signal: options.signal,
    });
    const summary = summarizeQuote(raw, USDC_DECIMALS, SKR_DECIMALS);
    // rate is SKR out per 1 USDC in; invert to get the price of one SKR in USDC. The price is
    // display-only: it never feeds isHolder or the discount (both are set from the balance read
    // above, before this quote). Sanitise it so a hostile or garbled feed (huge, zero, negative
    // or NaN) can only ever show 0, never a non-finite or negative number.
    const price = summary.rate > 0 ? 1 / summary.rate : 0;
    skrPriceInUsdc = Number.isFinite(price) && price > 0 ? price : 0;
  } catch {
    skrPriceInUsdc = 0;
  }

  return { skrBalanceUi, skrPriceInUsdc, isHolder, holderDisclosure: SKR_HOLDER_DISCLOSURE };
}

/** Resolve the SKR holder discount for a sale, in basis points. A non-holder always gets 0.
 *  A holder gets the creator's requested bps, clamped to [0, MAX] so the perk stays bounded
 *  whatever a listing asks for. A missing or junk request falls back to the house default. */
export function skrHolderDiscountBps(
  isHolder: boolean,
  creatorBps: number = DEFAULT_SKR_HOLDER_DISCOUNT_BPS,
): number {
  if (!isHolder) return 0;
  const requested = Number.isFinite(creatorBps)
    ? Math.trunc(creatorBps)
    : DEFAULT_SKR_HOLDER_DISCOUNT_BPS;
  return Math.max(0, Math.min(MAX_SKR_HOLDER_DISCOUNT_BPS, requested));
}

export interface DiscountedPrice {
  /** Discount actually applied, in basis points, after the holder and ceiling checks. */
  bps: number;
  /** The original price as a trimmed decimal string in USDC. */
  originalUi: string;
  /** The price after the SKR holder discount, as a trimmed decimal string in USDC. */
  discountedUi: string;
  /** USDC taken off, as a trimmed decimal string. */
  savingUi: string;
}

/** Apply the SKR holder discount to a USDC price. All maths runs in integer base units so a
 *  discount never introduces float dust. The saving is floored, so the buyer is never charged
 *  below the exact discounted figure and the price stays representable in USDC base units. */
export function applySkrHolderDiscount(
  priceUi: string,
  isHolder: boolean,
  creatorBps: number = DEFAULT_SKR_HOLDER_DISCOUNT_BPS,
): DiscountedPrice {
  const bps = skrHolderDiscountBps(isHolder, creatorBps);
  const total = toBaseUnits(priceUi, USDC_DECIMALS);
  const saving = (total * BigInt(bps)) / BPS_DENOMINATOR; // floor keeps the buyer fully charged
  const discounted = total - saving;
  return {
    bps,
    originalUi: fromBaseUnits(total, USDC_DECIMALS),
    discountedUi: fromBaseUnits(discounted, USDC_DECIMALS),
    savingUi: fromBaseUnits(saving, USDC_DECIMALS),
  };
}
