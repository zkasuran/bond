// Paid marketplace skills, run by the Bond agent runtime and unlocked per turn by
// an on-chain license check.
//
// The app sends the purchase signatures it holds (`skills: [{ id, signature }]`).
// A skill's tools are added to the turn only when that signature is a confirmed
// devnet transaction that paid the skill's creator in USDC. The payment is the
// license: there is no server-side account, and a forged or unrelated signature
// unlocks nothing. Verified signatures are cached for the life of the process.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Connection, PublicKey, type ParsedTransactionWithMeta, type TokenBalance } from "@solana/web3.js";
import { errText } from "./events.js";

const JUPITER = "https://lite-api.jup.ag";
const USDC_DECIMALS = 6;
const MAX_CLAIMS = 8;
// A creator may set an SKR holder discount up to 25% (app/src/solana/skr.ts), so a
// license is honoured when the creator received at least the discounted cut.
const MAX_DISCOUNT_BPS = 2500n;
const AUTHOR_SHARE_BPS = 8000n;

/** The server's view of the catalog: who gets paid and how much, per skill id. */
export interface PaidSkill {
  id: string;
  name: string;
  authorName: string;
  authorWallet: string;
  priceBaseUnits: bigint;
}

/** Where the 20% platform fee lands (app/src/skills/purchase.ts PLATFORM_WALLET). */
export const PLATFORM_WALLET = "E523zpkuVLybriL6E2djVCkUG4MHsS3TtT15DGfbiuwL";

export const PAID_SKILLS: Record<string, PaidSkill> = {
  "usdc-price-watcher": { id: "usdc-price-watcher", name: "USDC Price Watcher", authorName: "Orbit Labs", authorWallet: "Jt2kPLx8EBeeHCd9vmfGXUfbTiY3sJKUpfY9oNtF3Zh", priceBaseUnits: 500_000n },
  "wallet-summarizer": { id: "wallet-summarizer", name: "Wallet Summarizer", authorName: "Seeker Tools", authorWallet: "D8LsE3B7CetNPZzMYyidMKqjdZSsiVcDQdft7s45Qo7K", priceBaseUnits: 1_500_000n },
  "tx-explainer": { id: "tx-explainer", name: "Tx Explainer", authorName: "Pixel Forge", authorWallet: "6jRFz7D9jEyHCQoVvaYg4EmXPGL5Afb9b4VKt7T59fQS", priceBaseUnits: 2_000_000n },
  translator: { id: "translator", name: "Translator", authorName: "Lingua", authorWallet: "HCz5osKHHCjtcx23jHo7A8v1u7vmt9wEzACRYKqBFJds", priceBaseUnits: 250_000n },
};

/** The least a creator must have received for a purchase to count as a license. */
export function minAuthorBaseUnits(skill: PaidSkill): bigint {
  const authorCut = (skill.priceBaseUnits * AUTHOR_SHARE_BPS) / 10_000n;
  return (authorCut * (10_000n - MAX_DISCOUNT_BPS)) / 10_000n;
}

/** Net change of an owner's balance of one mint across a parsed transaction, in base units. */
export function tokenDelta(tx: ParsedTransactionWithMeta, owner: string, mint: string): bigint {
  const meta = tx.meta;
  if (!meta) return 0n;
  const sum = (rows: TokenBalance[] | null | undefined) =>
    (rows ?? [])
      .filter((b) => b.owner === owner && b.mint === mint)
      .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
}

/** How much of a mint an owner received in a successful transaction, in base units. */
export function usdcReceived(tx: ParsedTransactionWithMeta, owner: string, mint: string): bigint {
  if (!tx.meta || tx.meta.err) return 0n;
  const delta = tokenDelta(tx, owner, mint);
  return delta > 0n ? delta : 0n;
}

/** Pure license rule: a confirmed, successful transaction that paid the creator enough. */
export function isValidLicense(tx: ParsedTransactionWithMeta | null, skill: PaidSkill, mint: string): boolean {
  if (!tx || !tx.meta || tx.meta.err) return false;
  return usdcReceived(tx, skill.authorWallet, mint) >= minAuthorBaseUnits(skill);
}

/** A human label for an address Bond knows: the platform fee wallet or a skill creator. */
export function labelFor(address: string): string | undefined {
  if (address === PLATFORM_WALLET) return "Bond platform fee wallet";
  const skill = Object.values(PAID_SKILLS).find((k) => k.authorWallet === address);
  return skill ? `${skill.authorName}, creator of ${skill.name}` : undefined;
}

/** The marketplace skills a transaction paid for: the creator received at least the
 *  license minimum and the platform wallet received its fee in the same transaction. */
export function skillPurchasesIn(tx: ParsedTransactionWithMeta, mint: string): string[] {
  if (!tx.meta || tx.meta.err || usdcReceived(tx, PLATFORM_WALLET, mint) <= 0n) return [];
  return Object.values(PAID_SKILLS)
    .filter((k) => usdcReceived(tx, k.authorWallet, mint) >= minAuthorBaseUnits(k))
    .map((k) => k.name);
}

export interface SkillClaim {
  id: string;
  signature: string;
}

/** Keep only well-formed claims for known skills, deduped, capped. */
export function parseClaims(raw: unknown): SkillClaim[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, SkillClaim>();
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const { id, signature } = c as Record<string, unknown>;
    if (typeof id !== "string" || typeof signature !== "string") continue;
    if (!PAID_SKILLS[id] || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) continue;
    if (!out.has(id)) out.set(id, { id, signature });
    if (out.size >= MAX_CLAIMS) break;
  }
  return [...out.values()];
}

const verified = new Map<string, string>(); // signature -> skill id
const MAX_CACHE = 5000;

/** Return the skill ids whose claims check out on chain. A lookup failure fails closed. */
export async function verifyClaims(connection: Connection, claims: SkillClaim[], mint: string): Promise<string[]> {
  const ok: string[] = [];
  for (const claim of claims) {
    if (verified.get(claim.signature) === claim.id) {
      ok.push(claim.id);
      continue;
    }
    try {
      const tx = await connection.getParsedTransaction(claim.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (isValidLicense(tx, PAID_SKILLS[claim.id]!, mint)) {
        if (verified.size >= MAX_CACHE) verified.clear();
        verified.set(claim.signature, claim.id);
        ok.push(claim.id);
      }
    } catch {
      // RPC trouble means the skill stays locked for this turn, never unlocked by default.
    }
  }
  return ok;
}

/** Extra system-prompt lines for instruction-only skills that are unlocked. */
export function skillInstructions(ids: string[]): string[] {
  const lines: string[] = [];
  if (ids.includes("translator")) {
    lines.push(
      "The user owns the Translator skill: when asked to translate, give the translation first, then a one-line back-translation so they can check it.",
    );
  }
  return lines;
}

/** The tools for the unlocked skills. Every skill is read-only: none can move funds. */
export function skillTools(ids: string[], connection: Connection): ToolSet {
  const tools: ToolSet = {};

  if (ids.includes("usdc-price-watcher")) {
    tools.skill_usdc_price = tool({
      description: "Paid skill (USDC Price Watcher): current USDC price of a token, by symbol (SOL, JUP, BONK, SKR) or mint address.",
      inputSchema: z.object({ symbol: z.string().describe("token symbol or mint address") }),
      execute: async ({ symbol }) => {
        const known: Record<string, string> = {
          SOL: "So11111111111111111111111111111111111111112",
          JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
          BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
          SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3",
        };
        const mint = known[symbol.trim().toUpperCase()] ?? symbol.trim();
        try {
          const res = await fetch(`${JUPITER}/price/v3?ids=${encodeURIComponent(mint)}`);
          if (!res.ok) return { ok: false, error: `price HTTP ${res.status}` };
          const row = ((await res.json()) as Record<string, { usdPrice?: number }>)[mint];
          if (!row?.usdPrice) return { ok: false, error: "no price for that token" };
          return { ok: true, symbol: symbol.toUpperCase(), mint, usdcPrice: row.usdPrice, source: "Jupiter, mainnet" };
        } catch (err) {
          return { ok: false, error: errText(err) };
        }
      },
    });
  }

  if (ids.includes("wallet-summarizer")) {
    tools.skill_summarize_wallet = tool({
      description: "Paid skill (Wallet Summarizer): SOL balance, token holdings and the last few transactions of a devnet address. Read only.",
      inputSchema: z.object({ address: z.string().describe("base58 Solana address") }),
      execute: async ({ address }) => {
        try {
          const owner = new PublicKey(address);
          const [lamports, tokens, sigs] = await Promise.all([
            connection.getBalance(owner),
            connection.getParsedTokenAccountsByOwner(owner, {
              programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            }),
            connection.getSignaturesForAddress(owner, { limit: 5 }),
          ]);
          return {
            ok: true,
            cluster: "devnet",
            sol: lamports / 1e9,
            tokens: tokens.value
              .map((t) => t.account.data.parsed.info)
              .filter((i) => Number(i.tokenAmount.uiAmount) > 0)
              .slice(0, 10)
              .map((i) => ({ mint: i.mint, amount: i.tokenAmount.uiAmountString })),
            recent: sigs.map((s) => ({
              signature: s.signature,
              ok: s.err == null,
              time: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
            })),
          };
        } catch (err) {
          return { ok: false, error: errText(err) };
        }
      },
    });
  }

  if (ids.includes("tx-explainer")) {
    tools.skill_explain_transaction = tool({
      description: "Paid skill (Tx Explainer): decode a devnet transaction signature into who paid whom, how much, and whether it succeeded.",
      inputSchema: z.object({ signature: z.string().describe("base58 transaction signature") }),
      execute: async ({ signature }) => {
        try {
          const tx = await connection.getParsedTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          if (!tx) return { ok: false, error: "transaction not found on devnet" };
          const meta = tx.meta;
          const owners = new Set<string>();
          for (const b of [...(meta?.preTokenBalances ?? []), ...(meta?.postTokenBalances ?? [])]) {
            if (b.owner) owners.add(`${b.owner}|${b.mint}`);
          }
          const tokenMoves = [...owners]
            .map((key) => {
              const [owner, mint] = key.split("|") as [string, string];
              const decimals =
                meta?.postTokenBalances?.find((b) => b.owner === owner && b.mint === mint)?.uiTokenAmount.decimals ??
                USDC_DECIMALS;
              const label = labelFor(owner);
              return { owner, ...(label ? { label } : {}), mint, change: Number(tokenDelta(tx, owner, mint)) / 10 ** decimals };
            })
            .filter((m) => m.change !== 0);
          const purchases = tokenMoves.length ? [...new Set(tokenMoves.map((m) => m.mint))].flatMap((m) => skillPurchasesIn(tx, m)) : [];
          return {
            ok: true,
            succeeded: !meta?.err,
            ...(purchases.length
              ? { bondMarketplacePurchase: { skills: purchases, note: "Atomic split: 80% to the creator, 20% platform fee, one transaction." } }
              : {}),
            time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
            feeSol: (meta?.fee ?? 0) / 1e9,
            feePayer: tx.transaction.message.accountKeys[0]?.pubkey.toBase58(),
            tokenMoves,
            programs: [...new Set(tx.transaction.message.instructions.map((i) => i.programId.toBase58()))],
          };
        } catch (err) {
          return { ok: false, error: errText(err) };
        }
      },
    });
  }

  return tools;
}
