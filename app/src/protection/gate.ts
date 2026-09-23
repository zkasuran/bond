// The runtime that enforces the protection policy. requireAuth is the single entry point:
// call it before any guarded action and it decides, from the policy, whether to wave the
// action through, honour a recent auth, prompt biometrics, ask for the app PIN or degrade
// gracefully where no hardware exists.
//
// It never locks the identity key. A biometric enrollment change invalidates a
// SecureStore item guarded by requireAuthentication, which would destroy the did:key, so
// the key stays plainly readable and this gate sits one layer above it at the app level.
import { Platform } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import * as Crypto from "expo-crypto";
import {
  loadProtectionPolicy,
  secureDelete,
  secureGet,
  secureSet,
  type ProtectionMethod,
  type ProtectionPolicy,
  type Trigger,
} from "./policy";

const PIN_KEY = "bond.protection.pin";
const MIN_PIN_LENGTH = 4;

export interface RequireAuthOptions {
  /** For the spend trigger: the size of this spend in USDC. Below the policy threshold the
   *  spend is waved through without a prompt. */
  amountUsdc?: number;
  /** A short reason, woven into the prompt and returned on the result. */
  reason?: string;
  /** Override the native prompt message outright. */
  promptMessage?: string;
  /** Skip the re-auth grace window and always prompt. */
  force?: boolean;
  /** Inject a policy instead of loading it. Used by tests and callers that already hold one. */
  policy?: ProtectionPolicy;
}

export type AuthOutcome =
  | "granted" // the user passed the prompt just now
  | "grace" // a recent auth for this trigger is still valid
  | "not_required" // method is none or a spend below the threshold
  | "degraded" // no usable hardware or no way to prompt here, waved through with a note
  | "cancelled" // the user dismissed the prompt
  | "failed" // auth was attempted and rejected
  | "no_pin"; // the pin method is selected but no pin is set

export interface AuthResult {
  ok: boolean;
  trigger: Trigger;
  method: ProtectionMethod;
  outcome: AuthOutcome;
  note?: string;
}

// Last successful auth per trigger, in memory only so it never survives a cold start.
const lastAuthAt = new Map<Trigger, number>();

export function recordAuth(trigger: Trigger, at: number = Date.now()): void {
  lastAuthAt.set(trigger, at);
}

export function getLastAuthAt(trigger: Trigger): number | undefined {
  return lastAuthAt.get(trigger);
}

export function clearAuthCache(): void {
  lastAuthAt.clear();
}

/** Whether a prior auth is still inside the grace window. Pure, so the gate logic is testable. */
export function isWithinGrace(
  lastAt: number | undefined,
  reauthWindowSec: number,
  now: number = Date.now(),
): boolean {
  if (lastAt === undefined) return false;
  if (reauthWindowSec <= 0) return false;
  return now - lastAt < reauthWindowSec * 1000;
}

/** Whether a spend of this size trips the spend gate. An unknown amount is treated as guarded. */
export function spendNeedsAuth(policy: ProtectionPolicy, amountUsdc: number | undefined): boolean {
  if (amountUsdc === undefined) return true;
  return amountUsdc >= policy.spendThresholdUsdc;
}

const LABELS: Record<Trigger, string> = {
  openApp: "unlock Bond",
  runSkill: "run this skill",
  spend: "approve this payment",
  unlockKey: "use your signing key",
};

// The app PIN. Stored as a salted SHA-256 digest, never the PIN itself.
interface StoredPin {
  v: 1;
  salt: string;
  hash: string;
}

async function hashPin(pin: string, saltHex: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${saltHex}:${pin}`, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

export async function hasPin(): Promise<boolean> {
  return !!(await secureGet(PIN_KEY));
}

export async function setPin(pin: string): Promise<void> {
  if (pin.length < MIN_PIN_LENGTH) throw new Error(`PIN must be at least ${MIN_PIN_LENGTH} digits`);
  const bytes = await Crypto.getRandomBytesAsync(16);
  const saltHex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const rec: StoredPin = { v: 1, salt: saltHex, hash: await hashPin(pin, saltHex) };
  await secureSet(PIN_KEY, JSON.stringify(rec));
}

export async function clearPin(): Promise<void> {
  await secureDelete(PIN_KEY);
}

export async function verifyPin(pin: string): Promise<boolean> {
  const raw = await secureGet(PIN_KEY);
  if (!raw) return false;
  try {
    const rec = JSON.parse(raw) as StoredPin;
    return constantTimeEqual(await hashPin(pin, rec.salt), rec.hash);
  } catch {
    return false;
  }
}

// Compare two equal length hex digests without an early return, so a wrong PIN cannot be
// distinguished by timing.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface BiometricStatus {
  hasHardware: boolean;
  isEnrolled: boolean;
  types: LocalAuthentication.AuthenticationType[];
  /** True when the enrolled biometric is Android Class 3 or the iOS equivalent. */
  strong: boolean;
}

export async function getBiometricStatus(): Promise<BiometricStatus> {
  if (Platform.OS === "web") return { hasHardware: false, isEnrolled: false, types: [], strong: false };
  try {
    const [hasHardware, isEnrolled, types, level] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
      LocalAuthentication.getEnrolledLevelAsync(),
    ]);
    return {
      hasHardware,
      isEnrolled,
      types,
      strong: level === LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG,
    };
  } catch {
    return { hasHardware: false, isEnrolled: false, types: [], strong: false };
  }
}

async function biometricAvailable(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const [hw, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hw && enrolled;
  } catch {
    return false;
  }
}

// A PIN needs UI to collect, which a headless caller like the store does not have. A mounted
// LockGate registers a prompter here, so a spend or key unlock guarded by a PIN can surface
// the same PIN sheet no matter where the call came from.
export interface PinPromptRequest {
  title: string;
  subtitle?: string;
}
export type PinPrompter = (req: PinPromptRequest) => Promise<string | null>;

let pinPrompter: PinPrompter | null = null;
export function setPinPrompter(fn: PinPrompter | null): void {
  pinPrompter = fn;
}

async function runPinFlow(
  trigger: Trigger,
  method: ProtectionMethod,
  label: string,
): Promise<AuthResult> {
  const base = { trigger, method } as const;
  if (!(await hasPin())) {
    const note = "pin method selected but no pin is set";
    console.warn(`[protection] ${trigger}: ${note}`);
    return { ok: false, ...base, outcome: "no_pin", note };
  }
  if (!pinPrompter) {
    // Nothing is mounted to collect a PIN in this context. Degrade rather than hang and say
    // so, the same posture as a device with no biometric hardware.
    const note = "no pin prompt available in this context";
    console.warn(`[protection] ${trigger}: ${note}`);
    return { ok: true, ...base, outcome: "degraded", note };
  }
  const entered = await pinPrompter({ title: `Enter your PIN to ${label}` });
  if (entered === null) return { ok: false, ...base, outcome: "cancelled" };
  if (await verifyPin(entered)) {
    recordAuth(trigger);
    return { ok: true, ...base, outcome: "granted" };
  }
  return { ok: false, ...base, outcome: "failed", note: "incorrect pin" };
}

export async function requireAuth(
  trigger: Trigger,
  opts: RequireAuthOptions = {},
): Promise<AuthResult> {
  const policy = opts.policy ?? (await loadProtectionPolicy());
  const method = policy.methods[trigger];
  const base = { trigger, method } as const;

  // A spend below the configured threshold never prompts.
  if (trigger === "spend" && !spendNeedsAuth(policy, opts.amountUsdc)) {
    return { ok: true, ...base, outcome: "not_required", note: "below spend threshold" };
  }
  if (method === "none") {
    return { ok: true, ...base, outcome: "not_required" };
  }
  // A recent auth for this same trigger is still trusted.
  if (!opts.force && isWithinGrace(lastAuthAt.get(trigger), policy.reauthWindowSec)) {
    return { ok: true, ...base, outcome: "grace" };
  }

  const label = opts.reason ?? LABELS[trigger];
  const promptMessage = opts.promptMessage ?? `Confirm to ${label}`;

  if (method === "biometric") {
    if (await biometricAvailable()) {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage,
        disableDeviceFallback: false, // let the device passcode carry the fallback
        biometricsSecurityLevel: "strong", // Android Class 3 where available, ignored on iOS
        cancelLabel: "Cancel",
      });
      if (res.success) {
        recordAuth(trigger);
        return { ok: true, ...base, outcome: "granted" };
      }
      const cancelled =
        res.error === "user_cancel" || res.error === "app_cancel" || res.error === "system_cancel";
      return { ok: false, ...base, outcome: cancelled ? "cancelled" : "failed", note: res.error };
    }
    // No usable biometric hardware. Fall back to the app PIN if one is set, otherwise degrade
    // so the owner is never locked out of their own device by a missing sensor.
    if (await hasPin()) return runPinFlow(trigger, method, label);
    const note = "biometric unavailable on this device, allowed with a note";
    console.warn(`[protection] ${trigger}: ${note}`);
    return { ok: true, ...base, outcome: "degraded", note };
  }

  // method === "pin"
  return runPinFlow(trigger, method, label);
}
