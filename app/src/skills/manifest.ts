// The skill manifest: the self-contained shape of a marketplace listing. A skill is a
// tool or a small set of tools a creator publishes, priced in USDC, that a buyer installs
// so an agent can call it in a room. This file pulls in only the ToolSpec contract the
// agent bridge already speaks, so a purchased skill's tools drop straight into an agent
// turn with no translation.
import type { ToolSpec } from "../bridge/adapter";

/** Broad shelves a skill can sit under in the market. Kept small on purpose. */
export type SkillCategory =
  | "finance"
  | "wallet"
  | "media"
  | "productivity"
  | "developer"
  | "social";

/** How a purchased skill reaches the runtime that runs it.
 *  - "instructions": a prompt or SKILL.md the agent follows, no network call.
 *  - "http": a plain HTTP endpoint the agent calls with the tool arguments.
 *  - "mcp": a Model Context Protocol server the runtime connects to by URL.
 *  - "hosted": runs inside the Bond agent runtime, unlocked per turn once the server has
 *    verified the purchase transaction on chain. */
export type SkillDistribution = "instructions" | "http" | "mcp" | "hosted";

/** The creator who published a skill and receives the author cut on every sale. `did` is
 *  the creator's did:key and `wallet` is the same ed25519 key as a base58 Solana address,
 *  so the payout address and the signing identity are provably one key (see identity/keys). */
export interface SkillAuthor {
  did: string;
  wallet: string;
  displayName: string;
}

/** A skill price. USDC only for now. `amount` is a UI decimal string (e.g. "0.50") so it
 *  converts to integer base units without float loss (see solana/usdc.toBaseUnits). */
export interface SkillPrice {
  asset: "USDC";
  amount: string;
}

/** A published, installable skill. */
export interface Skill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  author: SkillAuthor;
  price: SkillPrice;
  distribution: SkillDistribution;
  /** Where the skill runs, for "http" and "mcp" distribution. Absent for "instructions". */
  endpoint?: string;
  /** The tool(s) the skill exposes, in the same shape the agent bridge already calls. */
  tools: ToolSpec[];
  /** Capabilities shown to the buyer at install, one plain line each. */
  permissions: string[];
}

/** Proof a buyer owns a skill: the settled on-chain payment, kept as the entitlement. */
export interface Entitlement {
  skillId: string;
  /** base58 transaction signature of the settled USDC split payment. The proof of purchase. */
  signature: string;
  /** Solana address that paid. */
  buyer: string;
  /** What was paid, as a UI decimal string in the price asset. */
  amount: string;
  asset: "USDC";
  cluster: "devnet" | "mainnet-beta" | "testnet";
  /** ISO 8601 time the entitlement was recorded. */
  purchasedAt: string;
}

/** A price formatted for display, e.g. "0.50 USDC". */
export function formatPrice(price: SkillPrice): string {
  return `${price.amount} ${price.asset}`;
}

/** A short human label for a distribution kind, for the detail screen. */
export function distributionLabel(distribution: SkillDistribution): string {
  switch (distribution) {
    case "instructions":
      return "Instructions";
    case "http":
      return "HTTP tool";
    case "mcp":
      return "MCP server";
    case "hosted":
      return "Bond runtime, unlocked by your payment";
  }
}
