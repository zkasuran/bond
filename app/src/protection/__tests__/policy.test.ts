import * as SecureStore from "expo-secure-store";
import {
  DEFAULT_POLICY,
  isPolicyDowngrade,
  loadProtectionPolicy,
  normalizePolicy,
  saveProtectionPolicy,
  strongestConfiguredTrigger,
  type ProtectionPolicy,
} from "../policy";

// An in-memory SecureStore so load/save can be exercised the way they run on device. The
// store lives inside the factory so the mock references nothing out of scope.
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

// Deterministic random so the per-install integrity key is stable across a test. A zero key still
// produces a well-defined, non-trivial HMAC tag, which is all the integrity gate needs here.
jest.mock("expo-crypto", () => ({
  getRandomBytesAsync: jest.fn(async (n: number) => new Uint8Array(n)),
}));

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

beforeEach(() => store.clear());

describe("protection policy load and save", () => {
  it("loads the default when nothing is stored, as a fresh copy", async () => {
    const p = await loadProtectionPolicy();
    expect(p).toEqual(DEFAULT_POLICY);
    p.methods.openApp = "pin";
    expect(DEFAULT_POLICY.methods.openApp).toBe("biometric");
  });

  it("round-trips a saved policy", async () => {
    const next: ProtectionPolicy = {
      methods: { openApp: "biometric", runSkill: "pin", spend: "none", unlockKey: "biometric" },
      spendThresholdUsdc: 25,
      reauthWindowSec: 300,
    };
    const saved = await saveProtectionPolicy(next);
    expect(saved).toEqual(next);
    expect(await loadProtectionPolicy()).toEqual(next);
  });

  it("recovers from corrupt JSON in the store", async () => {
    await SecureStore.setItemAsync("bond.protection.policy", "{not json");
    expect(await loadProtectionPolicy()).toEqual(DEFAULT_POLICY);
  });

  it("clamps an absurd window and a negative threshold on save", async () => {
    const saved = await saveProtectionPolicy({
      methods: DEFAULT_POLICY.methods,
      spendThresholdUsdc: -100,
      reauthWindowSec: 999_999_999,
    });
    expect(saved.spendThresholdUsdc).toBe(0);
    expect(saved.reauthWindowSec).toBe(24 * 60 * 60);
  });
});

describe("normalizePolicy", () => {
  it("keeps valid methods, replaces bad ones and fills missing triggers from the default", () => {
    const p = normalizePolicy({
      methods: { spend: "pin", runSkill: "bogus" },
      reauthWindowSec: -5,
    });
    expect(p.methods.spend).toBe("pin");
    expect(p.methods.runSkill).toBe(DEFAULT_POLICY.methods.runSkill);
    expect(p.methods.openApp).toBe(DEFAULT_POLICY.methods.openApp);
    expect(p.reauthWindowSec).toBe(0);
    expect(p.spendThresholdUsdc).toBe(DEFAULT_POLICY.spendThresholdUsdc);
  });

  it("falls back to the default for a null or non-object value", () => {
    expect(normalizePolicy(null)).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy(42)).toEqual(DEFAULT_POLICY);
  });
});

describe("fail-closed defaults", () => {
  it("never defaults a sensitive trigger to off", () => {
    expect(DEFAULT_POLICY.methods.openApp).not.toBe("none");
    expect(DEFAULT_POLICY.methods.runSkill).not.toBe("none");
    expect(DEFAULT_POLICY.methods.spend).not.toBe("none");
    expect(DEFAULT_POLICY.methods.unlockKey).not.toBe("none");
  });

  it("loads a guarded policy, never an open one, when the stored value is corrupt", async () => {
    await SecureStore.setItemAsync("bond.protection.policy", "{not json");
    const p = await loadProtectionPolicy();
    expect(p.methods.openApp).not.toBe("none");
    expect(p.methods.runSkill).not.toBe("none");
    expect(p.methods.spend).not.toBe("none");
  });
});

describe("spend threshold ceiling", () => {
  it("rejects an over-ceiling stored threshold to the default so it cannot disable spend auth", () => {
    expect(normalizePolicy({ spendThresholdUsdc: 1_000_000 }).spendThresholdUsdc).toBe(
      DEFAULT_POLICY.spendThresholdUsdc,
    );
    expect(normalizePolicy({ spendThresholdUsdc: 500 }).spendThresholdUsdc).toBe(
      DEFAULT_POLICY.spendThresholdUsdc,
    );
  });

  it("keeps a threshold inside the UI ceiling and clamps a negative up to zero", () => {
    expect(normalizePolicy({ spendThresholdUsdc: 100 }).spendThresholdUsdc).toBe(100);
    expect(normalizePolicy({ spendThresholdUsdc: 25 }).spendThresholdUsdc).toBe(25);
    expect(normalizePolicy({ spendThresholdUsdc: -100 }).spendThresholdUsdc).toBe(0);
  });
});

describe("isPolicyDowngrade", () => {
  it("flags a weaker method, a higher threshold or a longer window as a downgrade", () => {
    const base = DEFAULT_POLICY;
    expect(isPolicyDowngrade(base, { ...base, methods: { ...base.methods, spend: "none" } })).toBe(
      true,
    );
    expect(isPolicyDowngrade(base, { ...base, methods: { ...base.methods, spend: "pin" } })).toBe(
      true,
    );
    expect(isPolicyDowngrade(base, { ...base, spendThresholdUsdc: base.spendThresholdUsdc + 10 })).toBe(
      true,
    );
    expect(isPolicyDowngrade(base, { ...base, reauthWindowSec: base.reauthWindowSec + 60 })).toBe(
      true,
    );
  });

  it("does not flag an equal or strengthening change", () => {
    const base: ProtectionPolicy = {
      methods: { openApp: "pin", runSkill: "pin", spend: "pin", unlockKey: "pin" },
      spendThresholdUsdc: 50,
      reauthWindowSec: 300,
    };
    expect(isPolicyDowngrade(base, base)).toBe(false);
    expect(
      isPolicyDowngrade(base, { ...base, methods: { ...base.methods, spend: "biometric" } }),
    ).toBe(false);
    expect(isPolicyDowngrade(base, { ...base, spendThresholdUsdc: 10 })).toBe(false);
    expect(isPolicyDowngrade(base, { ...base, reauthWindowSec: 60 })).toBe(false);
  });
});

describe("strongestConfiguredTrigger", () => {
  it("names the trigger with the strongest method, or null when all are off", () => {
    expect(
      strongestConfiguredTrigger({
        methods: { openApp: "none", runSkill: "pin", spend: "biometric", unlockKey: "none" },
        spendThresholdUsdc: 1,
        reauthWindowSec: 60,
      }),
    ).toBe("spend");
    expect(
      strongestConfiguredTrigger({
        methods: { openApp: "none", runSkill: "none", spend: "none", unlockKey: "none" },
        spendThresholdUsdc: 1,
        reauthWindowSec: 60,
      }),
    ).toBeNull();
  });
});

describe("stored policy integrity", () => {
  it("rejects a direct all-none store write that lacks a valid tag, failing closed to the default", async () => {
    // A naive external write (DevTools on web, a rooted keystore) sets every guard off with no auth.
    await SecureStore.setItemAsync(
      "bond.protection.policy",
      JSON.stringify({
        methods: { openApp: "none", runSkill: "none", spend: "none", unlockKey: "none" },
        spendThresholdUsdc: 100,
        reauthWindowSec: 86400,
      }),
    );
    const p = await loadProtectionPolicy();
    expect(p).toEqual(DEFAULT_POLICY);
    expect(p.methods.spend).not.toBe("none");
  });

  it("trusts a policy written through the authenticated save path", async () => {
    const next = {
      methods: { openApp: "biometric", runSkill: "pin", spend: "none", unlockKey: "biometric" } as const,
      spendThresholdUsdc: 25,
      reauthWindowSec: 300,
    };
    await saveProtectionPolicy(next);
    expect(await loadProtectionPolicy()).toEqual(next);
  });

  it("rejects a forged envelope whose tag does not match its policy", async () => {
    await saveProtectionPolicy(DEFAULT_POLICY); // establishes the per-install key and a valid envelope
    // The attacker reuses the envelope shape but cannot produce a valid tag for an all-none policy.
    await SecureStore.setItemAsync(
      "bond.protection.policy",
      JSON.stringify({
        v: 1,
        policy: {
          methods: { openApp: "none", runSkill: "none", spend: "none", unlockKey: "none" },
          spendThresholdUsdc: 100,
          reauthWindowSec: 86400,
        },
        tag: "00".repeat(32),
      }),
    );
    expect(await loadProtectionPolicy()).toEqual(DEFAULT_POLICY);
  });
});
