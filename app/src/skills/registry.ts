// The skills registry: the curated catalog the market browses, plus the buyer's install
// and entitlement state. Entitlements persist on their own SecureStore item (localStorage
// on web), self contained so this never reads or writes the main Bond engine store. Each
// entitlement carries the settled transaction signature, so "installed" always means a
// payment that actually landed on chain, not a local flag a user could flip.
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { didToSolanaAddress, publicKeyToDid, solanaAddressToPublicKey } from "../identity/keys";
import type { Entitlement, Skill, SkillAuthor } from "./manifest";

const ENTITLEMENTS_KEY = "bond.skills.entitlements";

// A sample creator. The did:key is derived from the wallet, so the payout address and the
// signing identity are the same ed25519 key rather than two unrelated strings.
function sampleAuthor(wallet: string, displayName: string): SkillAuthor {
  return { wallet, displayName, did: publicKeyToDid(solanaAddressToPublicKey(wallet)) };
}

// Four sample skills across the shelves, each really runnable: the Bond runtime unlocks
// a skill for a turn once it has verified the purchase transaction on chain. Prices sit either side of the default spend
// gate (1 USDC) so the buy flow exercises both the waved-through and the prompted path.
const RAW_SKILL_CATALOG: Skill[] = [
  {
    id: "usdc-price-watcher",
    name: "USDC Price Watcher",
    description:
      "Watches SOL and major token prices against USDC and posts a plain price line into the room on request. Good for a quick check before a swap or a payment.",
    category: "finance",
    author: sampleAuthor("Jt2kPLx8EBeeHCd9vmfGXUfbTiY3sJKUpfY9oNtF3Zh", "Orbit Labs"),
    price: { asset: "USDC", amount: "0.50" },
    distribution: "hosted",
    tools: [
      {
        name: "skill_usdc_price",
        description: "Get the current price of a token in USDC.",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Token symbol, e.g. SOL or BONK." },
          },
          required: ["symbol"],
        },
      },
    ],
    permissions: [
      "Read public market price feeds",
      "Post a price line into the current room",
    ],
  },
  {
    id: "wallet-summarizer",
    name: "Wallet Summarizer",
    description:
      "Reads a Solana address you give it and summarizes balances and recent activity in one short paragraph. Read only. It never moves funds and never asks for a key.",
    category: "wallet",
    author: sampleAuthor("D8LsE3B7CetNPZzMYyidMKqjdZSsiVcDQdft7s45Qo7K", "Seeker Tools"),
    price: { asset: "USDC", amount: "1.50" },
    distribution: "hosted",
    tools: [
      {
        name: "skill_summarize_wallet",
        description: "Summarize balances and recent transactions for a Solana address.",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "string", description: "The base58 Solana address to summarize." },
          },
          required: ["address"],
        },
      },
    ],
    permissions: [
      "Read balances and recent transactions for an address you provide",
      "Read only, it never moves funds and never reads your signing key",
    ],
  },
  {
    id: "tx-explainer",
    name: "Tx Explainer",
    description:
      "Paste a transaction signature and get it in plain words: who paid whom, how much, which programs ran and whether it succeeded. Read only.",
    category: "developer",
    author: sampleAuthor("6jRFz7D9jEyHCQoVvaYg4EmXPGL5Afb9b4VKt7T59fQS", "Pixel Forge"),
    price: { asset: "USDC", amount: "2.00" },
    distribution: "hosted",
    tools: [
      {
        name: "skill_explain_transaction",
        description: "Decode a devnet transaction signature into transfers, fee, programs and outcome.",
        inputSchema: {
          type: "object",
          properties: {
            signature: { type: "string", description: "The base58 transaction signature." },
          },
          required: ["signature"],
        },
      },
    ],
    permissions: [
      "Read a transaction you give it from Solana devnet",
      "Read only, it never moves funds",
    ],
  },
  {
    id: "translator",
    name: "Translator",
    description:
      "Translates a message into a target language and back. Runs from instructions on the agent itself, so nothing is sent to a third party endpoint.",
    category: "productivity",
    author: sampleAuthor("HCz5osKHHCjtcx23jHo7A8v1u7vmt9wEzACRYKqBFJds", "Lingua"),
    price: { asset: "USDC", amount: "0.25" },
    distribution: "instructions",
    tools: [
      {
        name: "translate",
        description: "Translate text into a target language.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The text to translate." },
            targetLang: { type: "string", description: "Target language, e.g. es or Japanese." },
          },
          required: ["text", "targetLang"],
        },
      },
    ],
    permissions: [
      "Read the text you ask it to translate",
      "Runs on the agent from instructions, no network call",
    ],
  },
];

// A base58 string with no 0, O, I or l, the alphabet Solana addresses and signatures use.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

// Validate a catalog entry's shape before it is trusted (F14). There is no signed
// bond.skill.json ingestion yet, the catalog below is hardcoded, so this is the floor: the
// required fields are present, the price is a plain decimal, an endpoint is present exactly
// for the distributions that call out, and the author's did and payout wallet are the same
// ed25519 key. That did-to-wallet binding was only asserted in a test before, so a future
// listing could claim a famous creator's did while paying out to its own wallet. A full
// author signature over the manifest bytes is future work, tracked in the audit report.
export function isValidSkill(skill: Skill): boolean {
  if (!skill || typeof skill !== "object") return false;
  const okStr = (s: unknown): s is string => typeof s === "string" && s.length > 0;
  if (!okStr(skill.id) || !okStr(skill.name) || !okStr(skill.description)) return false;
  if (!skill.author || !okStr(skill.author.did) || !okStr(skill.author.wallet)) return false;
  if (!skill.price || skill.price.asset !== "USDC" || !/^\d+(\.\d+)?$/.test(skill.price.amount)) return false;
  if (!Array.isArray(skill.tools) || skill.tools.length === 0) return false;
  const needsEndpoint = skill.distribution === "http" || skill.distribution === "mcp";
  if (needsEndpoint !== (typeof skill.endpoint === "string")) return false;
  try {
    return didToSolanaAddress(skill.author.did) === skill.author.wallet;
  } catch {
    return false;
  }
}

// The catalog that ships is the validated one, so an entry that fails the shape or the
// did-to-wallet binding never reaches the market or a purchase.
export const SKILL_CATALOG: Skill[] = RAW_SKILL_CATALOG.filter(isValidSkill);

// Persist entitlements. SecureStore is native only, so fall back to localStorage on web
// the same way the identity and protection stores do rather than crashing.
async function persistGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function persistSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // best effort, web is lower assurance by design
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

function isEntitlement(v: unknown): v is Entitlement {
  const e = v as Partial<Entitlement>;
  return (
    !!e &&
    typeof e.skillId === "string" &&
    typeof e.signature === "string" &&
    typeof e.buyer === "string" &&
    typeof e.amount === "string" &&
    // F14 LOW: the local cache is only a display hint, the server's on-chain re-check is the
    // authority, but still reject a row whose signature or buyer is not even the right shape
    // so a hand-written localStorage value cannot pose as a settled purchase in the UI.
    e.signature.length >= 64 &&
    e.signature.length <= 90 &&
    BASE58.test(e.signature) &&
    e.buyer.length >= 32 &&
    e.buyer.length <= 44 &&
    BASE58.test(e.buyer)
  );
}

// Parse a stored blob into a clean map, dropping anything malformed so a hand edited or
// partially written store can never crash the market.
function parseEntitlements(raw: string | null): Record<string, Entitlement> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, Entitlement> = {};
    for (const [id, v] of Object.entries(obj)) {
      if (isEntitlement(v)) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export interface SkillsStoreState {
  catalog: Skill[];
  entitlements: Record<string, Entitlement>;
  loaded: boolean;

  /** Load stored entitlements. Safe to call more than once. */
  load: () => Promise<void>;
  getSkill: (id: string) => Skill | undefined;
  isInstalled: (id: string) => boolean;
  entitlementFor: (id: string) => Entitlement | undefined;
  /** Skills the buyer owns, in catalog order. */
  installedSkills: () => Skill[];
  /** Record a settled purchase as an owned entitlement and persist it. */
  install: (entitlement: Entitlement) => Promise<void>;
  /** Forget an entitlement locally. Does not refund; the on-chain payment stands. */
  uninstall: (skillId: string) => Promise<void>;
}

export const useSkills = create<SkillsStoreState>((set, get) => ({
  catalog: SKILL_CATALOG,
  entitlements: {},
  loaded: false,

  load: async () => {
    const raw = await persistGet(ENTITLEMENTS_KEY);
    set({ entitlements: parseEntitlements(raw), loaded: true });
  },

  getSkill: (id) => get().catalog.find((s) => s.id === id),

  isInstalled: (id) => !!get().entitlements[id],

  entitlementFor: (id) => get().entitlements[id],

  installedSkills: () => get().catalog.filter((s) => !!get().entitlements[s.id]),

  install: async (entitlement) => {
    const next = { ...get().entitlements, [entitlement.skillId]: entitlement };
    set({ entitlements: next });
    await persistSet(ENTITLEMENTS_KEY, JSON.stringify(next));
  },

  uninstall: async (skillId) => {
    const next = { ...get().entitlements };
    delete next[skillId];
    set({ entitlements: next });
    await persistSet(ENTITLEMENTS_KEY, JSON.stringify(next));
  },
}));
