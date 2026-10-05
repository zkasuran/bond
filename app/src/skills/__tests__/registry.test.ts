// The registry and its entitlement store are verified with expo-secure-store mocked by an
// in-memory map, so the suite never touches a native store. The catalog is checked for the
// invariant that a sample creator's did:key and payout wallet are the same ed25519 key. The
// store is checked for install, entitlement lookup, uninstall and a persistence round trip
// so "installed" survives a reload.
jest.mock("expo-secure-store", () => {
  const mem = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => mem.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      mem.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      mem.delete(k);
    }),
    __mem: mem,
  };
});

import * as SecureStore from "expo-secure-store";
import { didToSolanaAddress } from "../../identity/keys";
import type { Entitlement } from "../manifest";
import { SKILL_CATALOG, useSkills } from "../registry";

const mem = (SecureStore as unknown as { __mem: Map<string, string> }).__mem;

function entitlementFor(skillId: string): Entitlement {
  return {
    skillId,
    signature: "5".repeat(88),
    buyer: "BuyerAddress1111111111111111111111111111111",
    amount: "1.50",
    asset: "USDC",
    cluster: "devnet",
    purchasedAt: "2026-09-24T00:00:00.000Z",
  };
}

beforeEach(() => {
  mem.clear();
  jest.clearAllMocks();
  useSkills.setState({ entitlements: {}, loaded: false });
});

describe("SKILL_CATALOG", () => {
  it("ships four skills with unique ids", () => {
    expect(SKILL_CATALOG).toHaveLength(4);
    const ids = SKILL_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("derives each creator's did:key from the same key as the payout wallet", () => {
    for (const skill of SKILL_CATALOG) {
      expect(didToSolanaAddress(skill.author.did)).toBe(skill.author.wallet);
    }
  });

  it("gives an endpoint only to http and mcp skills, never to hosted or instruction skills", () => {
    for (const skill of SKILL_CATALOG) {
      if (skill.distribution === "http" || skill.distribution === "mcp") expect(typeof skill.endpoint).toBe("string");
      else expect(skill.endpoint).toBeUndefined();
    }
  });

  it("names hosted tools in the skill_ namespace the Bond runtime unlocks", () => {
    for (const skill of SKILL_CATALOG.filter((s) => s.distribution === "hosted")) {
      for (const t of skill.tools) expect(t.name.startsWith("skill_")).toBe(true);
    }
  });
});

describe("useSkills store", () => {
  it("starts with nothing installed", async () => {
    await useSkills.getState().load();
    expect(useSkills.getState().loaded).toBe(true);
    expect(useSkills.getState().isInstalled("wallet-summarizer")).toBe(false);
    expect(useSkills.getState().installedSkills()).toHaveLength(0);
  });

  it("records an entitlement, reports it installed and persists it", async () => {
    await useSkills.getState().load();
    const ent = entitlementFor("wallet-summarizer");
    await useSkills.getState().install(ent);

    expect(useSkills.getState().isInstalled("wallet-summarizer")).toBe(true);
    expect(useSkills.getState().entitlementFor("wallet-summarizer")).toEqual(ent);
    expect(useSkills.getState().installedSkills().map((s) => s.id)).toContain("wallet-summarizer");
    expect(SecureStore.setItemAsync).toHaveBeenCalled();
  });

  it("restores entitlements from storage on reload", async () => {
    await useSkills.getState().load();
    await useSkills.getState().install(entitlementFor("translator"));

    // wipe in-memory state but keep the backing store, then reload
    useSkills.setState({ entitlements: {}, loaded: false });
    expect(useSkills.getState().isInstalled("translator")).toBe(false);

    await useSkills.getState().load();
    expect(useSkills.getState().isInstalled("translator")).toBe(true);
  });

  it("uninstall forgets the entitlement and persists the removal", async () => {
    await useSkills.getState().load();
    await useSkills.getState().install(entitlementFor("tx-explainer"));
    await useSkills.getState().uninstall("tx-explainer");

    expect(useSkills.getState().isInstalled("tx-explainer")).toBe(false);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled(); // uninstall rewrites the map, it does not delete the item
  });

  it("survives a malformed store without throwing and drops bad rows", async () => {
    mem.set("bond.skills.entitlements", "{ not valid json");
    await useSkills.getState().load();
    expect(useSkills.getState().entitlements).toEqual({});

    mem.set(
      "bond.skills.entitlements",
      JSON.stringify({ good: entitlementFor("usdc-price-watcher"), bad: { skillId: 5 } }),
    );
    useSkills.setState({ entitlements: {}, loaded: false });
    await useSkills.getState().load();
    expect(Object.keys(useSkills.getState().entitlements)).toEqual(["good"]);
  });
});
