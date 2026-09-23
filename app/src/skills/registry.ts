// The skills registry: the curated catalog the market browses, plus the buyer's install
// and entitlement state. Entitlements persist on their own SecureStore item (localStorage
// on web), self contained so this never reads or writes the main Bond engine store. Each
// entitlement carries the settled transaction signature, so "installed" always means a
// payment that actually landed on chain, not a local flag a user could flip.
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { publicKeyToDid, solanaAddressToPublicKey } from "../identity/keys";
import type { Entitlement, Skill, SkillAuthor } from "./manifest";

const ENTITLEMENTS_KEY = "bond.skills.entitlements";

// A sample creator. The did:key is derived from the wallet, so the payout address and the
// signing identity are the same ed25519 key rather than two unrelated strings.
function sampleAuthor(wallet: string, displayName: string): SkillAuthor {
  return { wallet, displayName, did: publicKeyToDid(solanaAddressToPublicKey(wallet)) };
}

// Four real sample skills across the shelves. Prices sit either side of the default spend
// gate (1 USDC) so the buy flow exercises both the waved-through and the prompted path.
export const SKILL_CATALOG: Skill[] = [
  {
    id: "usdc-price-watcher",
    name: "USDC Price Watcher",
    description:
      "Watches SOL and major token prices against USDC and posts a plain price line into the room on request. Good for a quick check before a swap or a payment.",
    category: "finance",
    author: sampleAuthor("Jt2kPLx8EBeeHCd9vmfGXUfbTiY3sJKUpfY9oNtF3Zh", "Orbit Labs"),
    price: { asset: "USDC", amount: "0.50" },
    distribution: "http",
    endpoint: "https://skills.bond.zkasuran.dev/price",
    tools: [
      {
        name: "usdc_price",
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
    distribution: "mcp",
    endpoint: "https://skills.bond.zkasuran.dev/mcp/wallet-summarizer",
    tools: [
      {
        name: "summarize_wallet",
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
    id: "meme-image-generator",
    name: "Meme Image Generator",
    description:
      "Turns a prompt and an optional caption into a shareable image and drops it into the room. Handy for a reaction, a sticker or a quick banner.",
    category: "media",
    author: sampleAuthor("6jRFz7D9jEyHCQoVvaYg4EmXPGL5Afb9b4VKt7T59fQS", "Pixel Forge"),
    price: { asset: "USDC", amount: "2.00" },
    distribution: "http",
    endpoint: "https://skills.bond.zkasuran.dev/meme",
    tools: [
      {
        name: "generate_meme",
        description: "Generate an image from a prompt with optional top and bottom captions.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "What the image should show." },
            topText: { type: "string", description: "Optional caption across the top." },
            bottomText: { type: "string", description: "Optional caption across the bottom." },
          },
          required: ["prompt"],
        },
      },
    ],
    permissions: [
      "Send your prompt to an image model",
      "Post the generated image into the current room",
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
    typeof e.amount === "string"
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
