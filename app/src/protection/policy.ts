// The configurable protection policy for the agent. One document says which method guards
// each sensitive action, the spend size that trips the spend gate plus how long a fresh
// auth stays valid before the next prompt. It lives on its own SecureStore item so it is
// self contained: it never reads or writes the identity key or the app store. gate.ts is
// the runtime that enforces what this document declares.
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

export type ProtectionMethod = "none" | "pin" | "biometric";
export type Trigger = "openApp" | "runSkill" | "spend" | "unlockKey";

export const TRIGGERS: readonly Trigger[] = ["openApp", "runSkill", "spend", "unlockKey"];
export const METHODS: readonly ProtectionMethod[] = ["none", "pin", "biometric"];

export interface ProtectionPolicy {
  /** Which method guards each trigger. */
  methods: Record<Trigger, ProtectionMethod>;
  /** Spends at or above this USDC amount require auth for the spend trigger. */
  spendThresholdUsdc: number;
  /** Seconds a successful auth stays valid for a trigger before the next prompt. 0 disables the grace window. */
  reauthWindowSec: number;
}

// Sensible default: the two actions that move value or touch the key are guarded, the app
// opens and skills run freely so the app is usable out of the box. A one minute grace
// window keeps a burst of guarded actions from prompting on every tap.
export const DEFAULT_POLICY: ProtectionPolicy = {
  methods: {
    openApp: "none",
    runSkill: "none",
    spend: "biometric",
    unlockKey: "biometric",
  },
  spendThresholdUsdc: 1,
  reauthWindowSec: 60,
};

const POLICY_KEY = "bond.protection.policy";
const MAX_WINDOW_SEC = 24 * 60 * 60; // a day, so a stored value can never disable reauth forever
const MAX_THRESHOLD = 1_000_000;

function isMethod(v: unknown): v is ProtectionMethod {
  return v === "none" || v === "pin" || v === "biometric";
}

function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function freshDefault(): ProtectionPolicy {
  return { ...DEFAULT_POLICY, methods: { ...DEFAULT_POLICY.methods } };
}

// Merge a possibly partial or malformed stored value onto the default so a newly added
// trigger or a hand edited store can never crash the gate or silently disable it.
export function normalizePolicy(raw: unknown): ProtectionPolicy {
  const obj = (raw ?? {}) as Partial<ProtectionPolicy>;
  const inMethods = (obj.methods ?? {}) as Partial<Record<Trigger, ProtectionMethod>>;
  const methods = {} as Record<Trigger, ProtectionMethod>;
  for (const t of TRIGGERS) {
    const v = inMethods[t];
    methods[t] = isMethod(v) ? v : DEFAULT_POLICY.methods[t];
  }
  return {
    methods,
    spendThresholdUsdc: clampNumber(obj.spendThresholdUsdc, DEFAULT_POLICY.spendThresholdUsdc, 0, MAX_THRESHOLD),
    reauthWindowSec: clampNumber(obj.reauthWindowSec, DEFAULT_POLICY.reauthWindowSec, 0, MAX_WINDOW_SEC),
  };
}

// SecureStore is native only, so on web fall back to localStorage the same way the identity
// store does rather than crashing. gate.ts reuses these for the app PIN record.
export async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

export async function secureSet(key: string, value: string): Promise<void> {
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

export async function secureDelete(key: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // best effort
    }
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export async function loadProtectionPolicy(): Promise<ProtectionPolicy> {
  const raw = await secureGet(POLICY_KEY);
  if (!raw) return freshDefault();
  try {
    return normalizePolicy(JSON.parse(raw));
  } catch {
    return freshDefault();
  }
}

export async function saveProtectionPolicy(policy: ProtectionPolicy): Promise<ProtectionPolicy> {
  const clean = normalizePolicy(policy);
  await secureSet(POLICY_KEY, JSON.stringify(clean));
  return clean;
}
