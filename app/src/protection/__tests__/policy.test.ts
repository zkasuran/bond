import * as SecureStore from "expo-secure-store";
import {
  DEFAULT_POLICY,
  loadProtectionPolicy,
  normalizePolicy,
  saveProtectionPolicy,
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

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

beforeEach(() => store.clear());

describe("protection policy load and save", () => {
  it("loads the default when nothing is stored, as a fresh copy", async () => {
    const p = await loadProtectionPolicy();
    expect(p).toEqual(DEFAULT_POLICY);
    p.methods.openApp = "pin";
    expect(DEFAULT_POLICY.methods.openApp).toBe("none");
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
