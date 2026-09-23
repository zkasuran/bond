// Skill purchase: an atomic USDC split payment. One transaction pays the creator their
// cut and the platform its remainder, so a sale never half-settles. The split is computed
// in integer base units and the platform absorbs any rounding dust, so author + platform
// always sum to exactly the price and nothing leaks. The buyer signs through Mobile Wallet
// Adapter (wallet.signAndSendTransaction is Android-guarded); the settled signature is the
// proof of purchase recorded as the entitlement.
//
// Quoting and building the transaction are pure and run on any platform (web, iOS, jest).
// Only the execute step touches the wallet, so a judge on any device can see the price
// breakdown before an Android device signs.
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { SOLANA_CLUSTER, USDC_DECIMALS, USDC_DEVNET_MINT } from "../solana/config";
import { fromBaseUnits, toBaseUnits } from "../solana/usdc";
import { signAndSendTransaction } from "../solana/wallet";
import { requireAuth, type AuthResult } from "../protection/gate";
import type { ProtectionPolicy } from "../protection/policy";
import type { Entitlement, Skill } from "./manifest";

/** Platform fee in basis points. 2000 = 20%, so a creator keeps 80% of every sale. */
export const DEFAULT_PLATFORM_FEE_BPS = 2000;

/** Where the platform fee lands: zkasuran's Solana identity wallet, the same address the
 *  hackathon pays out to. Buyers pay the creator direct and the platform its remainder. */
export const PLATFORM_WALLET = "E523zpkuVLybriL6E2djVCkUG4MHsS3TtT15DGfbiuwL";

const BPS_DENOMINATOR = 10000n;

export interface Split {
  /** Total price in base units. */
  total: bigint;
  /** The creator's cut in base units. */
  authorAmount: bigint;
  /** The platform's remainder in base units, carrying any rounding dust. */
  platformAmount: bigint;
  platformFeeBps: number;
}

/** Split a total into a creator cut and a platform remainder. The author cut is floored so
 *  the platform absorbs the dust, which guarantees authorAmount + platformAmount === total
 *  and no fraction of a base unit ever leaks. */
export function computeSplit(total: bigint, platformFeeBps = DEFAULT_PLATFORM_FEE_BPS): Split {
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10000) {
    throw new Error("platformFeeBps must be an integer between 0 and 10000");
  }
  if (total < 0n) throw new Error("Total must not be negative");
  const authorBps = BigInt(10000 - platformFeeBps);
  const authorAmount = (total * authorBps) / BPS_DENOMINATOR; // floor division
  const platformAmount = total - authorAmount; // remainder keeps the total exact
  return { total, authorAmount, platformAmount, platformFeeBps };
}

export interface PurchaseQuote {
  skillId: string;
  mint: string;
  asset: string;
  decimals: number;
  platformFeeBps: number;
  authorWallet: string;
  platformWallet: string;
  /** Base units as integer strings, safe to carry across the wire. */
  totalBaseUnits: string;
  authorBaseUnits: string;
  platformBaseUnits: string;
  /** Trimmed decimal strings for display. */
  totalUi: string;
  authorUi: string;
  platformUi: string;
}

export interface PurchaseOptions {
  platformWallet?: string | PublicKey;
  platformFeeBps?: number;
  mint?: PublicKey;
  decimals?: number;
}

function toPublicKey(value: string | PublicKey): PublicKey {
  return typeof value === "string" ? new PublicKey(value) : value;
}

/** Price a skill purchase without a wallet or a network call. Runs anywhere. */
export function quoteSkillPurchase(skill: Skill, options: PurchaseOptions = {}): PurchaseQuote {
  const decimals = options.decimals ?? USDC_DECIMALS;
  const mint = options.mint ?? new PublicKey(USDC_DEVNET_MINT);
  const platformWallet = toPublicKey(options.platformWallet ?? PLATFORM_WALLET);
  const total = toBaseUnits(skill.price.amount, decimals);
  const split = computeSplit(total, options.platformFeeBps ?? DEFAULT_PLATFORM_FEE_BPS);
  return {
    skillId: skill.id,
    mint: mint.toBase58(),
    asset: skill.price.asset,
    decimals,
    platformFeeBps: split.platformFeeBps,
    authorWallet: skill.author.wallet,
    platformWallet: platformWallet.toBase58(),
    totalBaseUnits: split.total.toString(),
    authorBaseUnits: split.authorAmount.toString(),
    platformBaseUnits: split.platformAmount.toString(),
    totalUi: fromBaseUnits(split.total, decimals),
    authorUi: fromBaseUnits(split.authorAmount, decimals),
    platformUi: fromBaseUnits(split.platformAmount, decimals),
  };
}

export interface SkillPurchaseTx {
  transaction: Transaction;
  buyer: PublicKey;
  authorWallet: PublicKey;
  platformWallet: PublicKey;
  mint: PublicKey;
  decimals: number;
  split: Split;
  quote: PurchaseQuote;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Build the unsigned atomic split transaction: create the recipient token accounts
 *  idempotently, then a transferChecked to the creator and a transferChecked to the
 *  platform, all in one transaction. The buyer is fee payer. A leg with a zero amount is
 *  skipped, so a 100% or 0% fee still builds a valid transaction. */
export async function buildSkillPurchaseTransaction(
  connection: Connection,
  buyer: PublicKey,
  skill: Skill,
  options: PurchaseOptions = {},
): Promise<SkillPurchaseTx> {
  const decimals = options.decimals ?? USDC_DECIMALS;
  const mint = options.mint ?? new PublicKey(USDC_DEVNET_MINT);
  const authorWallet = new PublicKey(skill.author.wallet);
  const platformWallet = toPublicKey(options.platformWallet ?? PLATFORM_WALLET);

  const quote = quoteSkillPurchase(skill, { ...options, decimals, mint, platformWallet });
  const split = computeSplit(
    BigInt(quote.totalBaseUnits),
    options.platformFeeBps ?? DEFAULT_PLATFORM_FEE_BPS,
  );
  if (split.total <= 0n) {
    throw new Error("Skill price must be greater than zero to purchase");
  }

  const buyerTokenAccount = getAssociatedTokenAddressSync(mint, buyer);
  const authorTokenAccount = getAssociatedTokenAddressSync(mint, authorWallet);
  const platformTokenAccount = getAssociatedTokenAddressSync(mint, platformWallet);

  const transaction = new Transaction();

  if (split.authorAmount > 0n) {
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(buyer, authorTokenAccount, authorWallet, mint),
      createTransferCheckedInstruction(
        buyerTokenAccount,
        mint,
        authorTokenAccount,
        buyer,
        split.authorAmount,
        decimals,
      ),
    );
  }
  if (split.platformAmount > 0n) {
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(buyer, platformTokenAccount, platformWallet, mint),
      createTransferCheckedInstruction(
        buyerTokenAccount,
        mint,
        platformTokenAccount,
        buyer,
        split.platformAmount,
        decimals,
      ),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.feePayer = buyer;
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;

  return {
    transaction,
    buyer,
    authorWallet,
    platformWallet,
    mint,
    decimals,
    split,
    quote,
    blockhash,
    lastValidBlockHeight,
  };
}

export interface ExecutePurchaseContext extends PurchaseOptions {
  buyer: PublicKey;
  /** MWA auth token from the connected wallet (solana/store). */
  authToken: string;
  cluster?: Entitlement["cluster"];
  /** Inject a protection policy instead of loading it. Used by tests. */
  policy?: ProtectionPolicy;
}

export interface PurchaseResult {
  signature: string;
  split: Split;
  quote: PurchaseQuote;
  entitlement: Entitlement;
  auth: AuthResult;
}

/** Run a purchase end to end: check the spend gate, build the split transaction, sign and
 *  send it through the wallet, confirm it settled, then return the entitlement with the
 *  transaction signature as proof. Throws if the spend is not approved or the payment does
 *  not confirm, so nothing is recorded as owned unless the money actually moved. */
export async function executeSkillPurchase(
  connection: Connection,
  skill: Skill,
  ctx: ExecutePurchaseContext,
): Promise<PurchaseResult> {
  const amountUsdc = Number(skill.price.amount);

  const auth = await requireAuth("spend", {
    amountUsdc,
    reason: `buy ${skill.name}`,
    policy: ctx.policy,
  });
  if (!auth.ok) {
    throw new Error(`Payment was not approved (${auth.outcome}).`);
  }

  const built = await buildSkillPurchaseTransaction(connection, ctx.buyer, skill, ctx);
  const signature = await signAndSendTransaction(built.transaction, { authToken: ctx.authToken });

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (confirmation?.value?.err) {
    throw new Error(`Payment failed to confirm: ${JSON.stringify(confirmation.value.err)}`);
  }

  const entitlement: Entitlement = {
    skillId: skill.id,
    signature,
    buyer: ctx.buyer.toBase58(),
    amount: skill.price.amount,
    asset: skill.price.asset,
    cluster: ctx.cluster ?? SOLANA_CLUSTER,
    purchasedAt: new Date().toISOString(),
  };

  return { signature, split: built.split, quote: built.quote, entitlement, auth };
}
