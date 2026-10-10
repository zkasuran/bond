// The configurable protection policy for the agent. One document says which method guards
// each sensitive action, the spend size that trips the spend gate plus how long a fresh
// auth stays valid before the next prompt. It lives on its own SecureStore item so it is
// self contained: it never reads or writes the identity key or the app store. gate.ts is
// the runtime that enforces what this document declares.
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

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

// Secure by default: every sensitive action is guarded. biometric falls back to the app PIN
// wherever a sensor is missing, so a device with no biometric prompts for a PIN rather than
// opening wide, and a missing or corrupt stored policy loads this guarded shape rather than an
// open one. A one minute grace window keeps a burst of guarded actions from prompting on every tap.
export const DEFAULT_POLICY: ProtectionPolicy = {
  methods: {
    openApp: "biometric",
    runSkill: "biometric",
    spend: "biometric",
    unlockKey: "biometric",
  },
  spendThresholdUsdc: 1,
  reauthWindowSec: 60,
};

const POLICY_KEY = "bond.protection.policy";
// A per-install integrity secret, kept in the same secure store as the policy. See policyTag.
const POLICY_HMAC_KEY = "bond.protection.policy.key";
const POLICY_ENVELOPE_VERSION = 1;
const MAX_WINDOW_SEC = 24 * 60 * 60; // a day, so a stored value can never disable reauth forever
// The spend threshold ceiling matches the settings UI maximum. A stored value above it cannot
// silently disable spend auth: see normalizeThreshold.
const MAX_THRESHOLD = 100;

const METHOD_RANK: Record<ProtectionMethod, number> = { none: 0, pin: 1, biometric: 2 };

function isMethod(v: unknown): v is ProtectionMethod {
  return v === "none" || v === "pin" || v === "biometric";
}

function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

// A spend threshold above the UI ceiling, or a non-finite one, falls back to the default rather
// than clamping to the ceiling, so a hand edited store cannot leave spend auth effectively off by
// parking the threshold above every realistic payment. A negative value clamps up to 0, which asks
// on every payment, the secure direction.
function normalizeThreshold(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v > MAX_THRESHOLD) {
    return DEFAULT_POLICY.spendThresholdUsdc;
  }
  return Math.max(0, v);
}

// True when `next` weakens `current` on any axis: a weaker method on any trigger, a higher spend
// threshold (more payments skip auth) or a longer grace window (an auth stays valid longer). An
// equal or strengthening change is not a downgrade.
export function isPolicyDowngrade(current: ProtectionPolicy, next: ProtectionPolicy): boolean {
  for (const t of TRIGGERS) {
    if (METHOD_RANK[next.methods[t]] < METHOD_RANK[current.methods[t]]) return true;
  }
  if (next.spendThresholdUsdc > current.spendThresholdUsdc) return true;
  if (next.reauthWindowSec > current.reauthWindowSec) return true;
  return false;
}

// The trigger whose currently configured method is the strongest, or null when every trigger is
// off. A downgrade is challenged with this factor, so the weakest configured method can never be
// used to approve lowering a stronger one.
export function strongestConfiguredTrigger(policy: ProtectionPolicy): Trigger | null {
  let best: Trigger | null = null;
  let bestRank = 0;
  for (const t of TRIGGERS) {
    const r = METHOD_RANK[policy.methods[t]];
    if (r > bestRank) {
      bestRank = r;
      best = t;
    }
  }
  return best;
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
    spendThresholdUsdc: normalizeThreshold(obj.spendThresholdUsdc),
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

// Tamper evidence for the stored policy. A direct store write (DevTools on web, a rooted keystore)
// that turns every guard off is the vector F08/V3-2 describes. The policy is stored inside a signed
// envelope { v, policy, tag } where tag is an HMAC-SHA256 over the canonical policy keyed by a
// per-install secret. A policy that did not pass through saveProtectionPolicy carries no valid tag,
// so loadProtectionPolicy rejects it and fails closed to the guarded default. The secret lives in
// the same secure store: on native that is the OS keystore, which a non-rooted attacker cannot read,
// so the tag is a genuine keyed MAC there. On web it is localStorage, which the attacker can read,
// so the web tag only defends against naive or accidental writes (recorded as residue in the audit).
interface PolicyEnvelope {
  v: number;
  policy: ProtectionPolicy;
  tag: string;
}

// A deterministic, order-stable serialization of the policy fields, so the tag is computed over the
// same bytes on save and on load regardless of object key order.
function canonicalPolicy(p: ProtectionPolicy): string {
  return JSON.stringify([
    p.methods.openApp,
    p.methods.runSkill,
    p.methods.spend,
    p.methods.unlockKey,
    p.spendThresholdUsdc,
    p.reauthWindowSec,
  ]);
}

function policyTag(p: ProtectionPolicy, key: Uint8Array): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(canonicalPolicy(p))));
}

// Constant-time hex compare so a tag check does not leak via timing.
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readPolicyKey(): Promise<Uint8Array | null> {
  const hex = await secureGet(POLICY_HMAC_KEY);
  if (!hex) return null;
  try {
    const bytes = hexToBytes(hex);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

async function ensurePolicyKey(): Promise<Uint8Array> {
  const existing = await readPolicyKey();
  if (existing) return existing;
  const bytes = await Crypto.getRandomBytesAsync(32);
  await secureSet(POLICY_HMAC_KEY, bytesToHex(bytes));
  return bytes;
}

function asEnvelope(raw: unknown): PolicyEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.v !== "number" || typeof o.tag !== "string") return null;
  if (typeof o.policy !== "object" || o.policy === null) return null;
  return { v: o.v, policy: o.policy as ProtectionPolicy, tag: o.tag };
}

export async function loadProtectionPolicy(): Promise<ProtectionPolicy> {
  const raw = await secureGet(POLICY_KEY);
  if (!raw) return freshDefault();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshDefault();
  }
  // Integrity gate. Trust a stored policy only when it carries a valid tag from the authenticated
  // save path. A naive all-none write carries no envelope. A forged envelope carries a tag that does
  // not match its policy. Both fail closed to the guarded default (biometric on every trigger),
  // never to the attacker's open policy.
  const env = asEnvelope(parsed);
  if (env === null) return freshDefault();
  const key = await readPolicyKey();
  if (key === null) return freshDefault();
  const clean = normalizePolicy(env.policy);
  if (!constantTimeEqualHex(policyTag(clean, key), env.tag)) return freshDefault();
  return clean;
}

export async function saveProtectionPolicy(policy: ProtectionPolicy): Promise<ProtectionPolicy> {
  const clean = normalizePolicy(policy);
  const key = await ensurePolicyKey();
  const env: PolicyEnvelope = {
    v: POLICY_ENVELOPE_VERSION,
    policy: clean,
    tag: policyTag(clean, key),
  };
  await secureSet(POLICY_KEY, JSON.stringify(env));
  return clean;
}
