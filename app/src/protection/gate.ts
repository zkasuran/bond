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

// PIN brute-force limiter. A persisted counter of consecutive wrong PINs, with an
// exponential lockout once the threshold is passed, so a stolen device cannot grind the PIN.
const ATTEMPTS_KEY = "bond.protection.pin.attempts";
const PIN_LOCKOUT_THRESHOLD = 5; // wrong PINs allowed before the first lockout
const PIN_LOCKOUT_BASE_MS = 30_000; // lockout at the threshold, doubling each further failure
const PIN_LOCKOUT_MAX_MS = 15 * 60_000; // ceiling so a locked-out owner is never shut out forever

interface AttemptState {
  failed: number;
  lockedUntil: number;
}

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
  | "locked_out" // too many wrong PINs, locked until the backoff expires
  | "no_pin"; // pin method selected with no pin set (or no usable fallback here)

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

/** Whether a spend of this size trips the spend gate. Fails closed: an unknown, non-finite
 *  (NaN, Infinity) or negative amount can never be proven to sit below the threshold, so it
 *  always requires auth rather than slipping through the `>=` comparison as `false`. */
export function spendNeedsAuth(policy: ProtectionPolicy, amountUsdc: number | undefined): boolean {
  if (amountUsdc === undefined) return true;
  if (!Number.isFinite(amountUsdc) || amountUsdc < 0) return true;
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
  // A freshly set or changed PIN starts with a clean attempt counter.
  await resetPinAttempts();
}

export async function clearPin(): Promise<void> {
  await secureDelete(PIN_KEY);
  await resetPinAttempts();
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

/** The lockout duration after `failed` consecutive wrong PINs. 0 below the threshold, then
 *  doubling from the base, capped. Pure, so the backoff curve is tested directly. */
export function pinLockoutMs(failed: number): number {
  const over = failed - PIN_LOCKOUT_THRESHOLD;
  if (over < 0) return 0;
  return Math.min(PIN_LOCKOUT_BASE_MS * 2 ** over, PIN_LOCKOUT_MAX_MS);
}

export function lockoutRemainingMs(state: AttemptState, now: number = Date.now()): number {
  return Math.max(0, state.lockedUntil - now);
}

async function loadAttempts(): Promise<AttemptState> {
  const raw = await secureGet(ATTEMPTS_KEY);
  if (!raw) return { failed: 0, lockedUntil: 0 };
  try {
    const o = JSON.parse(raw) as Partial<AttemptState>;
    return { failed: Number(o.failed) || 0, lockedUntil: Number(o.lockedUntil) || 0 };
  } catch {
    return { failed: 0, lockedUntil: 0 };
  }
}

async function saveAttempts(state: AttemptState): Promise<void> {
  await secureSet(ATTEMPTS_KEY, JSON.stringify(state));
}

/** Clear the failed-attempt counter. Called on a correct PIN and when a PIN is set or removed. */
export async function resetPinAttempts(): Promise<void> {
  await secureDelete(ATTEMPTS_KEY);
}

/** Milliseconds remaining on an active PIN lockout, 0 when not locked. For the UI. */
export async function pinLockoutRemainingMs(now: number = Date.now()): Promise<number> {
  return lockoutRemainingMs(await loadAttempts(), now);
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
  // Honour an active lockout before prompting, so a wrong-PIN burst cannot be retried faster
  // than the backoff allows.
  const attempts = await loadAttempts();
  const remaining = lockoutRemainingMs(attempts);
  if (remaining > 0) {
    return {
      ok: false,
      ...base,
      outcome: "locked_out",
      note: `too many attempts, try again in ${Math.ceil(remaining / 1000)}s`,
    };
  }
  if (!pinPrompter) {
    // Nothing is mounted to collect a PIN here. Fail closed: a guarded action is denied when
    // it cannot be verified, rather than waved through with a warning.
    const note = "no pin prompt available in this context";
    console.warn(`[protection] ${trigger}: ${note}`);
    return { ok: false, ...base, outcome: "no_pin", note };
  }
  const entered = await pinPrompter({ title: `Enter your PIN to ${label}` });
  if (entered === null) return { ok: false, ...base, outcome: "cancelled" };
  if (await verifyPin(entered)) {
    await resetPinAttempts();
    recordAuth(trigger);
    return { ok: true, ...base, outcome: "granted" };
  }
  // Wrong PIN: bump the counter and lock out once the threshold is passed.
  const failed = attempts.failed + 1;
  const lockMs = pinLockoutMs(failed);
  await saveAttempts({ failed, lockedUntil: lockMs > 0 ? Date.now() + lockMs : attempts.lockedUntil });
  if (lockMs > 0) {
    return {
      ok: false,
      ...base,
      outcome: "locked_out",
      note: `too many attempts, try again in ${Math.ceil(lockMs / 1000)}s`,
    };
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
    // No usable biometric hardware. Fall back to the app PIN if one is set, otherwise fail
    // closed: with no sensor and no PIN there is no way to prove it is the owner, so a
    // sensitive action is denied and the caller is told to set a PIN rather than waved through.
    if (await hasPin()) return runPinFlow(trigger, method, label);
    const note = "no biometric hardware and no PIN set; set a PIN to protect this action";
    console.warn(`[protection] ${trigger}: ${note}`);
    return { ok: false, ...base, outcome: "no_pin", note };
  }

  // method === "pin"
  return runPinFlow(trigger, method, label);
}
