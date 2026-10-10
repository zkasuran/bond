// Paid marketplace skills, run by the Bond agent runtime and unlocked per turn by
// an on-chain license check plus a wallet-ownership proof.
//
// The app sends the purchase claims it holds, each with a proof:
// `skills: [{ id, signature, buyer, proof }]`. A skill's tools are added to the turn only
// when all of these hold: the signature is a confirmed devnet transaction that split USDC to
// the skill's creator and the platform, the claimed buyer is the wallet that actually paid,
// and the claim carries a valid wallet-ownership proof (F14 HIGH). The proof is an Ed25519
// signature by the device did:key over a fresh server challenge bound to the skill id, the
// purchase signature and the payer, plus a one-time wallet-signed binding that ties that
// did:key to the paying wallet. So naming the public payer address is not enough: a bystander
// who read the purchase off the explorer cannot produce the payer wallet's signature, and the
// challenge expires so a captured proof bundle cannot be replayed after its short window. The
// on-chain license fact (does this tx license this skill for this buyer) is cached per
// signature, skill and buyer; the proof is re-checked every turn.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Connection, PublicKey, type ParsedTransactionWithMeta, type TokenBalance } from "@solana/web3.js";
import { createHmac, createPublicKey, timingSafeEqual, verify as nodeCryptoVerify } from "node:crypto";
import { config } from "../config.js";
import { errText } from "./events.js";

const JUPITER = "https://lite-api.jup.ag";
const USDC_DECIMALS = 6;
const MAX_CLAIMS = 8;
// A creator may set an SKR holder discount up to 25% (app/src/solana/skr.ts), so a
// license is honoured when the creator received at least the discounted cut.
const MAX_DISCOUNT_BPS = 2500n;
const AUTHOR_SHARE_BPS = 8000n;
// The platform's share of a sale, the complement of the creator cut. The platform-fee gate
// (F14 MEDIUM) requires at least this share at full discount, not merely a non-zero leg.
const PLATFORM_SHARE_BPS = 10_000n - AUTHOR_SHARE_BPS;
// Rounding slack, in base units, so an honest discounted sale whose integer split lands a base
// unit under the computed floor is never rejected. Far below any meaningful fee, so it does
// not let a dust-fee bypass through.
const PLATFORM_FEE_TOLERANCE = 4n;

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

/** The least the platform must have received for a purchase to count as a license (F14
 *  MEDIUM). The platform leg is its share of the price at the maximum SKR discount, less a few
 *  base units of rounding slack. This blocks a self-built purchase that pays the author the
 *  discounted minimum and the platform only dust, which the old `> 0` gate let through. */
export function minPlatformBaseUnits(skill: PaidSkill): bigint {
  const platformCut = (skill.priceBaseUnits * PLATFORM_SHARE_BPS) / 10_000n;
  const atMaxDiscount = (platformCut * (10_000n - MAX_DISCOUNT_BPS)) / 10_000n;
  return atMaxDiscount > PLATFORM_FEE_TOLERANCE ? atMaxDiscount - PLATFORM_FEE_TOLERANCE : 0n;
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

/** Pure license rule: a confirmed, successful transaction that paid the claimed buyer's
 *  USDC to the creator and the platform in one go. The license binds to the buyer who paid
 *  (F14 HIGH): the buyer's own USDC balance must have dropped in this transaction, so a
 *  signature replayed by a different buyer licenses nothing. The platform fee leg must be at
 *  least the expected platform share for the skill (F14 MEDIUM): an author-only transfer, or
 *  one that pays the platform only dust, does not unlock a skill. */
export function isValidLicense(
  tx: ParsedTransactionWithMeta | null,
  skill: PaidSkill,
  mint: string,
  buyer: string,
): boolean {
  if (!tx || !tx.meta || tx.meta.err) return false;
  // The claimed buyer must be the payer: their token balance went down in this transaction.
  if (tokenDelta(tx, buyer, mint) >= 0n) return false;
  // The platform fee leg must be at least the expected platform share, not merely non-zero.
  if (usdcReceived(tx, PLATFORM_WALLET, mint) < minPlatformBaseUnits(skill)) return false;
  // The creator received at least the discounted minimum.
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
  /** The wallet that paid, declared by the claimant. The license check requires the
   *  on-chain USDC debit to come from this wallet, and the proof below must prove control of
   *  it, so one buyer's purchase signature cannot license another buyer. */
  buyer: string;
  /** Wallet-ownership + freshness proof (F14 HIGH). Absent or invalid means the claim unlocks
   *  nothing, even when the on-chain payment is real. */
  proof?: ClaimProof;
}

// ---------------------------------------------------------------------------
// Wallet-ownership proof (F14 HIGH)
//
// The claimant must prove control of the wallet that paid, not merely name it. The proof is
// an Ed25519 signature by the device did:key over a fresh server challenge bound to the skill
// id, the purchase signature and the payer, plus a one-time wallet-signed binding (produced by
// the app's wallet<->did binding flow) that ties that did:key to the paying wallet. A reader of
// the public explorer has the purchase signature and the payer address but neither private key,
// so cannot forge either signature. The challenge expires, so a captured bundle cannot be
// replayed after its window.
// ---------------------------------------------------------------------------

/** The wallet<->did binding the app produced once, mirrored here for verification. The field
 *  names and the signed-message format match app/src/solana/binding.ts exactly. */
export interface WalletBinding {
  did: string;
  walletAddress: string;
  nonce: string;
  context: string;
  version: number;
  issuedAt: string;
  expiresAt: string;
  /** base64url Ed25519 signature by the WALLET over the binding message. */
  walletSignature: string;
  /** base64url Ed25519 signature by the device DID:KEY over the binding message. */
  didSignature: string;
}

export interface ClaimProof {
  /** The fresh server challenge, echoed inside the signed claim message. */
  challenge: string;
  /** The device did:key that signed this claim. */
  did: string;
  /** base64url Ed25519 signature by the did:key over the claim message. */
  didSig: string;
  /** The one-time wallet<->did binding tying the did:key to the paying wallet. */
  binding: WalletBinding;
}

// Must match app/src/solana/binding.ts BINDING_CONTEXT and the binding message format.
const BINDING_CONTEXT = "bond:wallet-did-binding:v1";
const BINDING_CLOCK_SKEW_MS = 5 * 60 * 1000;

// Stateless freshness challenge: an HMAC over an expiry timestamp keyed by the server secret,
// so the server verifies it issued the value with no per-user session state.
const CHALLENGE_DOMAIN = "bond:skill-claim-challenge:v1";
const SKILL_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_CLOCK_SKEW_MS = 60 * 1000;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DID_KEY_PREFIX = "did:key:z";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const utf8 = new TextEncoder();

/** Minimal, dependency-free Base58 (Bitcoin alphabet) encode, cross-checked against
 *  @solana/web3.js in the tests. */
export function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = BASE58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = "1" + out;
  return out === "" ? "1" : out;
}

/** Minimal, dependency-free Base58 decode. Throws on an invalid character. */
export function base58Decode(s: string): Uint8Array {
  let num = 0n;
  for (const ch of s) {
    const v = BASE58_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("invalid base58 character");
    num = num * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (let i = 0; i < s.length && s[i] === "1"; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

/** did:key ed25519 -> 32-byte public key. Mirrors app/src/identity/keys.ts didToPublicKey. */
export function didKeyToPublicKey(did: string): Uint8Array {
  if (typeof did !== "string" || !did.startsWith(DID_KEY_PREFIX)) {
    throw new Error("not a did:key ed25519 identity");
  }
  const bytes = base58Decode(did.slice(DID_KEY_PREFIX.length));
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new Error("did:key is not ed25519");
  }
  return bytes.slice(2);
}

/** Verify a 64-byte Ed25519 signature against a 32-byte raw public key, using Node's native
 *  crypto. Returns false rather than throwing on any malformed input. */
function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return nodeCryptoVerify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

function fromB64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function challengeMac(expiresAt: number): string {
  return createHmac("sha256", `${CHALLENGE_DOMAIN}:${config.bondBearer}`)
    .update(`${CHALLENGE_DOMAIN}.${expiresAt}`)
    .digest("hex");
}

/** Issue a short-lived, stateless freshness challenge for a skill-claim proof. */
export function issueSkillChallenge(now: number = Date.now()): string {
  const expiresAt = now + SKILL_CHALLENGE_TTL_MS;
  return `${expiresAt}.${challengeMac(expiresAt)}`;
}

/** True only for a challenge this server issued that is still inside its window. */
export function verifySkillChallenge(challenge: unknown, now: number = Date.now()): boolean {
  if (typeof challenge !== "string" || challenge.length > 256) return false;
  const dot = challenge.indexOf(".");
  if (dot <= 0) return false;
  const expiresAt = Number(challenge.slice(0, dot));
  if (!Number.isInteger(expiresAt)) return false;
  if (now > expiresAt) return false;
  if (expiresAt - now > SKILL_CHALLENGE_TTL_MS + CHALLENGE_CLOCK_SKEW_MS) return false;
  const mac = challenge.slice(dot + 1);
  const expected = challengeMac(expiresAt);
  if (mac.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}

function bindingMessageBytes(b: WalletBinding): Uint8Array {
  return utf8.encode(
    [
      "Bond wallet binding v1",
      `context: ${b.context}`,
      `did: ${b.did}`,
      `wallet: ${b.walletAddress}`,
      `nonce: ${b.nonce}`,
      `version: ${b.version}`,
      `issued: ${b.issuedAt}`,
      `expires: ${b.expiresAt}`,
    ].join("\n"),
  );
}

function claimMessageBytes(id: string, txSignature: string, buyer: string, challenge: string): Uint8Array {
  return utf8.encode(
    [
      "Bond skill claim v1",
      `skill: ${id}`,
      `tx: ${txSignature}`,
      `buyer: ${buyer}`,
      `challenge: ${challenge}`,
    ].join("\n"),
  );
}

/** Verify the one-time binding ties `expectedDid` to `expectedWallet`: both the wallet and the
 *  did signed the same binding message, the context tag matches and the window is open. */
function verifyWalletBinding(
  b: WalletBinding,
  expectedDid: string,
  expectedWallet: string,
  now: number = Date.now(),
): boolean {
  try {
    if (!b || typeof b !== "object") return false;
    if (b.did !== expectedDid || b.walletAddress !== expectedWallet) return false;
    if (b.context !== BINDING_CONTEXT) return false;
    if (typeof b.version !== "number" || b.version < 1) return false;
    const expiresAt = Date.parse(b.expiresAt);
    const issuedAt = Date.parse(b.issuedAt);
    if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
    if (!Number.isFinite(issuedAt) || issuedAt - now > BINDING_CLOCK_SKEW_MS) return false;
    const message = bindingMessageBytes(b);
    const walletKey = new PublicKey(b.walletAddress).toBytes();
    const didKey = didKeyToPublicKey(b.did);
    return (
      verifyEd25519(message, fromB64Url(b.walletSignature), walletKey) &&
      verifyEd25519(message, fromB64Url(b.didSignature), didKey)
    );
  } catch {
    return false;
  }
}

/** Verify a claim's wallet-ownership + freshness proof (F14 HIGH). The device did:key must
 *  have signed this exact claim over a fresh challenge, and the binding must tie that did:key
 *  to the wallet named as the payer. The caller still checks that wallet paid on chain. */
export function verifyClaimProof(claim: SkillClaim, now: number = Date.now()): boolean {
  const p = claim.proof;
  if (!p) return false;
  if (!verifySkillChallenge(p.challenge, now)) return false;
  let didKey: Uint8Array;
  try {
    didKey = didKeyToPublicKey(p.did);
  } catch {
    return false;
  }
  const message = claimMessageBytes(claim.id, claim.signature, claim.buyer, p.challenge);
  if (!verifyEd25519(message, fromB64Url(p.didSig), didKey)) return false;
  // The binding must tie this exact did:key to the wallet that paid on chain.
  return verifyWalletBinding(p.binding, p.did, claim.buyer, now);
}

const MAX_PROOF_STR = 256;
function boundedStr(v: unknown, max = MAX_PROOF_STR): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/** Pull a well-shaped, length-bounded proof out of untrusted input, or undefined. The crypto
 *  is verified later; this only bounds sizes so a hostile claim cannot inflate memory or CPU. */
function sanitizeProof(raw: unknown): ClaimProof | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const challenge = boundedStr(r.challenge);
  const did = boundedStr(r.did, 128);
  const didSig = boundedStr(r.didSig, 128);
  const b = r.binding;
  if (!challenge || !did || !didSig || !b || typeof b !== "object") return undefined;
  const bb = b as Record<string, unknown>;
  const bindingDid = boundedStr(bb.did, 128);
  const walletAddress = boundedStr(bb.walletAddress, 64);
  const nonce = boundedStr(bb.nonce, 128);
  const context = boundedStr(bb.context, 128);
  const issuedAt = boundedStr(bb.issuedAt, 64);
  const expiresAt = boundedStr(bb.expiresAt, 64);
  const walletSignature = boundedStr(bb.walletSignature, 128);
  const didSignature = boundedStr(bb.didSignature, 128);
  const version =
    typeof bb.version === "number" && Number.isInteger(bb.version) ? bb.version : undefined;
  if (
    !bindingDid ||
    !walletAddress ||
    !nonce ||
    !context ||
    !issuedAt ||
    !expiresAt ||
    !walletSignature ||
    !didSignature ||
    version === undefined
  ) {
    return undefined;
  }
  return {
    challenge,
    did,
    didSig,
    binding: { did: bindingDid, walletAddress, nonce, context, version, issuedAt, expiresAt, walletSignature, didSignature },
  };
}

/** Keep only well-formed claims for known skills, deduped, capped. A claim must carry a
 *  base58 signature and a base58 buyer address, else it is dropped. A well-shaped proof is
 *  carried through for verification; a claim with no proof is kept but unlocks nothing, since
 *  verifyClaims rejects it (F14 HIGH). */
export function parseClaims(raw: unknown): SkillClaim[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, SkillClaim>();
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const { id, signature, buyer } = c as Record<string, unknown>;
    if (typeof id !== "string" || typeof signature !== "string" || typeof buyer !== "string") continue;
    if (!PAID_SKILLS[id] || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) continue;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(buyer)) continue;
    if (!out.has(id)) {
      const claim: SkillClaim = { id, signature, buyer };
      const proof = sanitizeProof((c as Record<string, unknown>).proof);
      if (proof) claim.proof = proof;
      out.set(id, claim);
    }
    if (out.size >= MAX_CLAIMS) break;
  }
  return [...out.values()];
}

// signature|id|buyer that passed the on-chain license rule. The proof is re-checked every
// turn, so a cached license fact never unlocks a skill without a fresh, valid proof.
const licensed = new Set<string>();
const MAX_CACHE = 5000;

/** Return the skill ids whose claims check out: a valid wallet-ownership proof (every turn)
 *  and a confirmed on-chain license (cached). A lookup failure fails closed. The cache key
 *  includes the buyer, so a verified license never leaks the unlock to another buyer. */
export async function verifyClaims(connection: Connection, claims: SkillClaim[], mint: string): Promise<string[]> {
  const ok: string[] = [];
  for (const claim of claims) {
    // Wallet-ownership + freshness, checked every turn (F14 HIGH): a claim that only names the
    // payer, with no valid proof, unlocks nothing even when the payment is real.
    if (!verifyClaimProof(claim)) continue;
    const licenseKey = `${claim.signature}|${claim.id}|${claim.buyer}`;
    if (licensed.has(licenseKey)) {
      ok.push(claim.id);
      continue;
    }
    try {
      const tx = await connection.getParsedTransaction(claim.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (isValidLicense(tx, PAID_SKILLS[claim.id]!, mint, claim.buyer)) {
        if (licensed.size >= MAX_CACHE) licensed.clear();
        licensed.add(licenseKey);
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
