import * as SecureStore from "expo-secure-store";
import * as LA from "expo-local-authentication";
import {
  clearAuthCache,
  getLastAuthAt,
  isWithinGrace,
  pinLockoutMs,
  requireAuth,
  setPin,
  setPinPrompter,
  spendNeedsAuth,
} from "../gate";
import { DEFAULT_POLICY, type ProtectionMethod, type ProtectionPolicy, type Trigger } from "../policy";

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

// Deterministic crypto: a zero salt and a digest that just echoes its input, so a PIN
// verifies against itself and nothing else, without any native module.
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { HEX: "hex" },
  getRandomBytesAsync: jest.fn(async (n: number) => new Uint8Array(n)),
  digestStringAsync: jest.fn(async (_algo: string, data: string) => `digest(${data})`),
}));

jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
  supportedAuthenticationTypesAsync: jest.fn(async () => [1]),
  getEnrolledLevelAsync: jest.fn(async () => 3),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
}));

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const auth = LA.authenticateAsync as jest.Mock;
const hasHw = LA.hasHardwareAsync as jest.Mock;
const enrolled = LA.isEnrolledAsync as jest.Mock;

function policyWith(
  over: {
    methods?: Partial<Record<Trigger, ProtectionMethod>>;
    spendThresholdUsdc?: number;
    reauthWindowSec?: number;
  } = {},
): ProtectionPolicy {
  return {
    methods: { ...DEFAULT_POLICY.methods, ...(over.methods ?? {}) },
    spendThresholdUsdc: over.spendThresholdUsdc ?? DEFAULT_POLICY.spendThresholdUsdc,
    reauthWindowSec: over.reauthWindowSec ?? DEFAULT_POLICY.reauthWindowSec,
  };
}

beforeEach(() => {
  store.clear();
  clearAuthCache();
  setPinPrompter(null);
  auth.mockReset();
  auth.mockResolvedValue({ success: true });
  hasHw.mockReset();
  hasHw.mockResolvedValue(true);
  enrolled.mockReset();
  enrolled.mockResolvedValue(true);
});

describe("isWithinGrace", () => {
  it("is false with no prior auth", () => {
    expect(isWithinGrace(undefined, 60)).toBe(false);
  });
  it("is true inside the window and false past it", () => {
    const now = 1_000_000;
    expect(isWithinGrace(now - 30_000, 60, now)).toBe(true);
    expect(isWithinGrace(now - 61_000, 60, now)).toBe(false);
  });
  it("is false when the window is zero", () => {
    const now = 1_000_000;
    expect(isWithinGrace(now, 0, now)).toBe(false);
  });
});

describe("spendNeedsAuth", () => {
  it("treats an unknown amount as guarded", () => {
    expect(spendNeedsAuth(policyWith({ spendThresholdUsdc: 10 }), undefined)).toBe(true);
  });
  it("waves through a spend under the threshold", () => {
    expect(spendNeedsAuth(policyWith({ spendThresholdUsdc: 10 }), 9.99)).toBe(false);
  });
  it("guards a spend at or above the threshold", () => {
    expect(spendNeedsAuth(policyWith({ spendThresholdUsdc: 10 }), 10)).toBe(true);
  });

  it("fails closed on a non-finite or negative amount", () => {
    const p = policyWith({ spendThresholdUsdc: 10 });
    expect(spendNeedsAuth(p, Number.NaN)).toBe(true);
    expect(spendNeedsAuth(p, Number.POSITIVE_INFINITY)).toBe(true);
    expect(spendNeedsAuth(p, Number.NEGATIVE_INFINITY)).toBe(true);
    expect(spendNeedsAuth(p, -5)).toBe(true);
  });
});

describe("requireAuth", () => {
  it("passes without prompting when the method is none", async () => {
    const r = await requireAuth("runSkill", { policy: policyWith({ methods: { runSkill: "none" } }) });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("not_required");
    expect(auth).not.toHaveBeenCalled();
  });

  it("waves a spend below the threshold through without prompting", async () => {
    const r = await requireAuth("spend", {
      amountUsdc: 5,
      policy: policyWith({ methods: { spend: "biometric" }, spendThresholdUsdc: 10 }),
    });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("not_required");
    expect(auth).not.toHaveBeenCalled();
  });

  it("prompts biometrics for a spend at the threshold and records the auth", async () => {
    const p = policyWith({ methods: { spend: "biometric" }, spendThresholdUsdc: 10 });
    const r = await requireAuth("spend", { amountUsdc: 10, policy: p });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("granted");
    expect(auth).toHaveBeenCalledTimes(1);
    expect(getLastAuthAt("spend")).toBeGreaterThan(0);
  });

  it("honours the grace window instead of prompting twice", async () => {
    const p = policyWith({ methods: { unlockKey: "biometric" }, reauthWindowSec: 60 });
    expect((await requireAuth("unlockKey", { policy: p })).outcome).toBe("granted");
    const second = await requireAuth("unlockKey", { policy: p });
    expect(second.ok).toBe(true);
    expect(second.outcome).toBe("grace");
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("force re-prompts even inside the grace window", async () => {
    const p = policyWith({ methods: { unlockKey: "biometric" }, reauthWindowSec: 60 });
    await requireAuth("unlockKey", { policy: p });
    const forced = await requireAuth("unlockKey", { policy: p, force: true });
    expect(forced.outcome).toBe("granted");
    expect(auth).toHaveBeenCalledTimes(2);
  });

  it("reports a cancelled biometric prompt", async () => {
    auth.mockResolvedValueOnce({ success: false, error: "user_cancel" });
    const r = await requireAuth("openApp", { policy: policyWith({ methods: { openApp: "biometric" } }) });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("cancelled");
  });

  it("reports a failed biometric prompt", async () => {
    auth.mockResolvedValueOnce({ success: false, error: "authentication_failed" });
    const r = await requireAuth("openApp", { policy: policyWith({ methods: { openApp: "biometric" } }) });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("failed");
  });

  it("fails closed when biometrics are unavailable and no PIN is set", async () => {
    hasHw.mockResolvedValue(false);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const r = await requireAuth("openApp", { policy: policyWith({ methods: { openApp: "biometric" } }) });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("no_pin");
    expect(auth).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fails closed on a spend when there is no hardware and no PIN", async () => {
    hasHw.mockResolvedValue(false);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const r = await requireAuth("spend", {
      amountUsdc: 100,
      policy: policyWith({ methods: { spend: "biometric" }, spendThresholdUsdc: 1 }),
    });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("no_pin");
    expect(auth).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to the PIN when biometrics are unavailable and a PIN is set", async () => {
    hasHw.mockResolvedValue(false);
    await setPin("2468");
    setPinPrompter(async () => "2468");
    const r = await requireAuth("openApp", { policy: policyWith({ methods: { openApp: "biometric" } }) });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("granted");
    expect(auth).not.toHaveBeenCalled();
  });

  it("verifies the PIN for the pin method and rejects a wrong one", async () => {
    const p = policyWith({ methods: { spend: "pin" }, spendThresholdUsdc: 0 });
    await setPin("1357");
    setPinPrompter(async () => "0000");
    const bad = await requireAuth("spend", { amountUsdc: 5, policy: p });
    expect(bad.ok).toBe(false);
    expect(bad.outcome).toBe("failed");

    setPinPrompter(async () => "1357");
    const good = await requireAuth("spend", { amountUsdc: 5, policy: p });
    expect(good.ok).toBe(true);
    expect(good.outcome).toBe("granted");
  });

  it("treats a dismissed PIN sheet as cancelled", async () => {
    await setPin("1357");
    setPinPrompter(async () => null);
    const r = await requireAuth("openApp", { policy: policyWith({ methods: { openApp: "pin" } }) });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("cancelled");
  });

  it("returns no_pin when the pin method is selected but none is set", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    setPinPrompter(async () => "1234");
    const r = await requireAuth("openApp", { policy: policyWith({ methods: { openApp: "pin" } }) });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("no_pin");
    warn.mockRestore();
  });

  it("requires auth for a spend whose amount is NaN instead of waving it through", async () => {
    const p = policyWith({ methods: { spend: "biometric" }, spendThresholdUsdc: 10 });
    const r = await requireAuth("spend", { amountUsdc: Number.NaN, policy: p });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("granted");
  });

  it("fails closed when a PIN is set but no prompt is mounted to collect it", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await setPin("4321");
    setPinPrompter(null);
    const r = await requireAuth("spend", {
      amountUsdc: 5,
      policy: policyWith({ methods: { spend: "pin" }, spendThresholdUsdc: 0 }),
    });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("no_pin");
    warn.mockRestore();
  });
});

describe("pinLockoutMs", () => {
  it("is zero below the threshold then backs off exponentially, capped", () => {
    expect(pinLockoutMs(1)).toBe(0);
    expect(pinLockoutMs(4)).toBe(0);
    expect(pinLockoutMs(5)).toBe(30_000);
    expect(pinLockoutMs(6)).toBe(60_000);
    expect(pinLockoutMs(7)).toBe(120_000);
    expect(pinLockoutMs(100)).toBe(15 * 60_000);
  });
});

describe("PIN attempt limiter", () => {
  it("locks out after repeated wrong PINs and refuses even a correct one while locked", async () => {
    const p = policyWith({ methods: { spend: "pin" }, spendThresholdUsdc: 0 });
    await setPin("1357");
    setPinPrompter(async () => "0000"); // always wrong
    let last;
    for (let i = 0; i < 5; i++) {
      last = await requireAuth("spend", { amountUsdc: 5, policy: p, force: true });
    }
    expect(last!.ok).toBe(false);
    expect(last!.outcome).toBe("locked_out");

    setPinPrompter(async () => "1357"); // correct, but locked out
    const during = await requireAuth("spend", { amountUsdc: 5, policy: p, force: true });
    expect(during.ok).toBe(false);
    expect(during.outcome).toBe("locked_out");
  });

  it("clears the counter on a correct PIN before any lockout", async () => {
    const p = policyWith({ methods: { spend: "pin" }, spendThresholdUsdc: 0 });
    await setPin("2468");
    setPinPrompter(async () => "0000");
    await requireAuth("spend", { amountUsdc: 5, policy: p, force: true }); // one wrong
    setPinPrompter(async () => "2468");
    const good = await requireAuth("spend", { amountUsdc: 5, policy: p, force: true });
    expect(good.outcome).toBe("granted");
    // The reset means the next wrong attempt starts the count over, not mid-way to a lockout.
    setPinPrompter(async () => "0000");
    const afterReset = await requireAuth("spend", { amountUsdc: 5, policy: p, force: true });
    expect(afterReset.outcome).toBe("failed");
  });
});
