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
import { scrypt } from "@noble/hashes/scrypt.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  isPolicyDowngrade,
  loadProtectionPolicy,
  secureDelete,
  secureGet,
  secureSet,
  strongestConfiguredTrigger,
  type ProtectionMethod,
  type ProtectionPolicy,
  type Trigger,
} from "./policy";

const PIN_KEY = "bond.protection.pin";
const MIN_PIN_LENGTH = 4;

// The app PIN is a CONVENIENCE factor, not the root of trust. It gates app level actions and is the
// fallback where no biometric sensor exists, but a 4 digit PIN under any KDF stays offline-crackable
// once the stored record leaks (web localStorage, a rooted keystore), so it is deliberately not
// relied on to protect funds by itself. The real security is the hardware wallet: Seed Vault holds
// the keys and Mobile Wallet Adapter signs every transaction behind the device keyguard, which this
// PIN never substitutes for. Treat the PIN as a speed bump, the wallet as the lock.
//
// The PIN is stretched with a slow, salted, memory hard KDF (scrypt), so a leaked record is not
// trivially brute-forceable for a short numeric PIN. RFC 7914 interactive cost.
const PIN_SCRYPT_N = 1 << 14; // 16384
const PIN_SCRYPT_R = 8;
const PIN_SCRYPT_P = 1;
const PIN_DK_LEN = 32;

// PIN brute-force limiter. A persisted counter of consecutive wrong PINs, with an exponential
// lockout once the threshold is passed, so a stolen device cannot grind the PIN. The lockout clock
// is monotonic (see monotonicNowMs), so winding the device wall clock forward cannot clear it, and
// a cumulative hard ceiling that no clock or restart can reset backstops the timed backoff.
const ATTEMPTS_KEY = "bond.protection.pin.attempts";
const PIN_LOCKOUT_THRESHOLD = 5; // wrong PINs allowed before the first lockout
const PIN_LOCKOUT_BASE_MS = 30_000; // lockout at the threshold, doubling each further failure
const PIN_LOCKOUT_MAX_MS = 15 * 60_000; // ceiling so a locked-out owner is never shut out forever
const PIN_HARD_ATTEMPT_CEILING = 10; // cumulative wrong PINs before a permanent lock, time cannot clear it

interface AttemptState {
  failed: number;
  /** Monotonic deadline (monotonicNowMs units) the lockout runs until. */
  lockUntilMono: number;
}

// A monotonic time source for the lockout. performance.now() counts from process start and is
// immune to wall-clock changes, so an attacker who advances the device date cannot make a lockout
// look expired. It resets on an app restart, so the timed backoff does not survive one; the
// cumulative hard ceiling is what bounds attempts across restarts. Falls back to the wall clock
// only where no monotonic source exists, which is recorded as a known limit.
function monotonicNowMs(): number {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  if (p && typeof p.now === "function") {
    const t = p.now();
    if (typeof t === "number" && Number.isFinite(t)) return t;
  }
  return Date.now();
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
// The amount approved at the last successful spend auth, so the grace window is scoped to that
// size and a later, larger spend cannot ride a small approval through unprompted.
const lastAuthAmount = new Map<Trigger, number>();

// Whether the app PIN that currently exists was enrolled during THIS session through the lock
// screen bootstrap path (LockGate "Set a PIN"), which unlocks the session without proving any prior
// owner factor. A factor created that way is not evidence the owner is present, so it must not be
// allowed to authenticate a protection DOWNGRADE: otherwise an attacker who picks up a device with
// no biometric and no PIN could set a PIN and immediately use it to switch protection off. In
// memory only, so a cold start clears it, which means a PIN that survives a restart is treated as
// pre-existing (see the residue note in the audit).
let pinEnrolledThisSession = false;

/** Record that a PIN was just enrolled through the unguarded bootstrap path. LockGate calls this
 *  right after setPin in its "Set a PIN" flow, so authorizePolicyChange can refuse to treat that
 *  PIN as a pre-existing factor. */
export function markPinEnrolledInSession(): void {
  pinEnrolledThisSession = true;
}

export function wasPinEnrolledThisSession(): boolean {
  return pinEnrolledThisSession;
}

export function recordAuth(trigger: Trigger, at: number = Date.now(), amountUsdc?: number): void {
  lastAuthAt.set(trigger, at);
  if (typeof amountUsdc === "number" && Number.isFinite(amountUsdc)) {
    lastAuthAmount.set(trigger, amountUsdc);
  } else {
    lastAuthAmount.delete(trigger);
  }
}

export function getLastAuthAt(trigger: Trigger): number | undefined {
  return lastAuthAt.get(trigger);
}

export function clearAuthCache(): void {
  lastAuthAt.clear();
  lastAuthAmount.clear();
  // In-memory session state, cleared with the rest of the auth cache.
  pinEnrolledThisSession = false;
}

/** Whether a prior spend auth still covers a spend of this size. The grace is scoped to the amount
 *  last approved: a later spend at or below it rides the window, a larger or unknown amount does
 *  not and must prompt again. */
function spendGraceCovers(amountUsdc: number | undefined): boolean {
  const approved = lastAuthAmount.get("spend");
  if (approved === undefined || amountUsdc === undefined) return false;
  if (!Number.isFinite(amountUsdc)) return false;
  return amountUsdc <= approved;
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

// The app PIN. Stored as a slow, salted scrypt digest, never the PIN itself. The KDF parameters
// travel with the record so a future cost bump can be verified against an older record.
interface StoredPin {
  v: 2;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

function kdfHash(pin: string, saltHex: string, N: number, r: number, p: number): string {
  const out = scrypt(utf8ToBytes(pin), hexToBytes(saltHex), { N, r, p, dkLen: PIN_DK_LEN });
  return bytesToHex(out);
}

export async function hasPin(): Promise<boolean> {
  return !!(await secureGet(PIN_KEY));
}

export async function setPin(pin: string): Promise<void> {
  if (pin.length < MIN_PIN_LENGTH) throw new Error(`PIN must be at least ${MIN_PIN_LENGTH} digits`);
  const bytes = await Crypto.getRandomBytesAsync(16);
  const saltHex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const rec: StoredPin = {
    v: 2,
    kdf: "scrypt",
    N: PIN_SCRYPT_N,
    r: PIN_SCRYPT_R,
    p: PIN_SCRYPT_P,
    salt: saltHex,
    hash: kdfHash(pin, saltHex, PIN_SCRYPT_N, PIN_SCRYPT_R, PIN_SCRYPT_P),
  };
  await secureSet(PIN_KEY, JSON.stringify(rec));
  // A freshly set or changed PIN starts with a clean attempt counter.
  await resetPinAttempts();
}

export async function clearPin(): Promise<void> {
  await secureDelete(PIN_KEY);
  // No PIN remains, so there is nothing left to rate-limit. Delete the counter outright rather than
  // leaving an explicit clean record behind.
  await secureDelete(ATTEMPTS_KEY);
}

export async function verifyPin(pin: string): Promise<boolean> {
  const raw = await secureGet(PIN_KEY);
  if (!raw) return false;
  try {
    const rec = JSON.parse(raw) as StoredPin;
    if (rec.v !== 2 || rec.kdf !== "scrypt") return false;
    return constantTimeEqual(kdfHash(pin, rec.salt, rec.N, rec.r, rec.p), rec.hash);
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

/** Whether the cumulative wrong-PIN count has passed the hard ceiling. This lock is driven by a
 *  persisted count, not a clock, so neither advancing the device time nor restarting the app
 *  clears it. */
export function isHardLocked(state: AttemptState): boolean {
  return state.failed >= PIN_HARD_ATTEMPT_CEILING;
}

export function lockoutRemainingMs(state: AttemptState, nowMono: number = monotonicNowMs()): number {
  const remaining = state.lockUntilMono - nowMono;
  if (remaining <= 0) return 0;
  // Within one run the deadline is never set beyond the ceiling, so a larger value can only be a
  // stale deadline from a previous process. The timed backoff does not survive a restart; the hard
  // ceiling bounds attempts across restarts.
  if (remaining > PIN_LOCKOUT_MAX_MS) return 0;
  return remaining;
}

async function loadAttempts(): Promise<AttemptState> {
  const raw = await secureGet(ATTEMPTS_KEY);
  if (raw !== null) {
    try {
      const o = JSON.parse(raw) as Partial<AttemptState>;
      const failed = Number(o.failed);
      const lockUntilMono = Number(o.lockUntilMono);
      if (Number.isFinite(failed) && failed >= 0 && Number.isFinite(lockUntilMono)) {
        return { failed, lockUntilMono };
      }
      // Malformed fields fall through to the fail-closed path below.
    } catch {
      // An unparseable record falls through to the fail-closed path below.
    }
  }
  // The counter is missing or corrupt. resetPinAttempts always writes an explicit clean record, so
  // an absent or malformed one WHILE A PIN IS ENROLLED means the attempts store was cleared out from
  // under the gate: deleting the unprotected key on web localStorage or a rooted keystore write.
  // Fail closed. Impose at least the standard cooldown instead of handing back a fresh unlimited
  // allowance, which is what resetting to zero would do: one delete would otherwise wipe both the
  // timed lockout and the cumulative hard ceiling. Persist the hostile state so the deadline is
  // fixed (monotonic) rather than pushed forward on every read. With no PIN enrolled there is
  // nothing to grind, so a clean zero state is correct (first run or right after clearPin).
  if (await hasPin()) {
    const hostile: AttemptState = {
      failed: PIN_LOCKOUT_THRESHOLD,
      lockUntilMono: monotonicNowMs() + PIN_LOCKOUT_BASE_MS,
    };
    await saveAttempts(hostile);
    return hostile;
  }
  return { failed: 0, lockUntilMono: 0 };
}

async function saveAttempts(state: AttemptState): Promise<void> {
  await secureSet(ATTEMPTS_KEY, JSON.stringify(state));
}

/** Reset the failed-attempt counter to a clean, explicit record. Called on a correct PIN and when a
 *  PIN is set. The record is WRITTEN, not deleted, so that an ABSENT counter while a PIN is enrolled
 *  is an anomaly loadAttempts can treat as hostile rather than as a fresh allowance. */
export async function resetPinAttempts(): Promise<void> {
  await saveAttempts({ failed: 0, lockUntilMono: 0 });
}

// Serialize the read-modify-write of the attempt counter. Without this, two overlapping wrong
// guesses each read the same stale `failed`, each write `stale + 1`, and the counter never reaches
// the lockout threshold. The mutex plus a reload inside the critical section makes every increment
// land on the freshest value.
let attemptLock: Promise<unknown> = Promise.resolve();
function withAttemptLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = attemptLock.then(fn, fn);
  attemptLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

type AttemptReservation = { ok: true; failed: number } | { ok: false; note: string };

/** Atomically decide whether another PIN guess is allowed and, if so, CONSUME the attempt before
 *  the prompt is shown. The hard-ceiling and timed-lockout checks and the increment happen together
 *  inside the mutex, so N concurrent callers cannot all pass the ceiling on one stale pre-prompt
 *  read (a check-to-act race) and then all prompt. A denied reservation does not increment and does
 *  not prompt. The consumed attempt is rolled back only on a genuine success (runPinFlow calls
 *  resetPinAttempts). A wrong PIN or a cancelled sheet leaves it standing, so neither a wrong-guess
 *  burst nor a cancel burst can probe the PIN for free. */
async function reserveAttempt(): Promise<AttemptReservation> {
  return withAttemptLock(async () => {
    const cur = await loadAttempts();
    if (isHardLocked(cur)) {
      return { ok: false, note: "too many attempts, reset Bond to set a new PIN" };
    }
    const remaining = lockoutRemainingMs(cur);
    if (remaining > 0) {
      return { ok: false, note: `too many attempts, try again in ${Math.ceil(remaining / 1000)}s` };
    }
    const failed = cur.failed + 1;
    const lockMs = pinLockoutMs(failed);
    const lockUntilMono =
      lockMs > 0 ? monotonicNowMs() + Math.min(lockMs, PIN_LOCKOUT_MAX_MS) : cur.lockUntilMono;
    await saveAttempts({ failed, lockUntilMono });
    return { ok: true, failed };
  });
}

/** Milliseconds remaining on an active PIN lockout, 0 when not locked. For the UI. */
export async function pinLockoutRemainingMs(nowMono: number = monotonicNowMs()): Promise<number> {
  return lockoutRemainingMs(await loadAttempts(), nowMono);
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
  amountUsdc?: number,
): Promise<AuthResult> {
  const base = { trigger, method } as const;
  if (!(await hasPin())) {
    const note = "pin method selected but no pin is set";
    console.warn(`[protection] ${trigger}: ${note}`);
    return { ok: false, ...base, outcome: "no_pin", note };
  }
  if (!pinPrompter) {
    // Nothing is mounted to collect a PIN here. Fail closed, consuming no attempt: a guarded action
    // is denied when it cannot be verified, rather than waved through with a warning.
    const note = "no pin prompt available in this context";
    console.warn(`[protection] ${trigger}: ${note}`);
    return { ok: false, ...base, outcome: "no_pin", note };
  }
  // Reserve (and consume) the attempt BEFORE prompting. The ceiling and lockout checks live inside
  // the same atomic step as the increment, so a concurrent burst cannot all clear the ceiling on one
  // stale count and then prompt. A denied reservation never reaches the prompt.
  const reservation = await reserveAttempt();
  if (!reservation.ok) {
    return { ok: false, ...base, outcome: "locked_out", note: reservation.note };
  }
  const entered = await pinPrompter({ title: `Enter your PIN to ${label}` });
  // A dismissed sheet does not roll the reservation back: the slot was already consumed, matching
  // "roll back only on a genuine success". This bounds probing by cancel as well as by wrong guess.
  if (entered === null) return { ok: false, ...base, outcome: "cancelled" };
  if (await verifyPin(entered)) {
    // Genuine success: roll the consumed attempt back to a clean counter.
    await resetPinAttempts();
    recordAuth(trigger, Date.now(), amountUsdc);
    return { ok: true, ...base, outcome: "granted" };
  }
  // Wrong PIN: the attempt is already consumed. Report the lockout the reservation produced.
  if (reservation.failed >= PIN_HARD_ATTEMPT_CEILING) {
    return {
      ok: false,
      ...base,
      outcome: "locked_out",
      note: "too many attempts, reset Bond to set a new PIN",
    };
  }
  const lockMs = pinLockoutMs(reservation.failed);
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
  // A recent auth for this same trigger is still trusted. For spend the grace is scoped to the
  // amount last approved, so a later, larger spend cannot ride a small approval through unprompted.
  if (!opts.force && isWithinGrace(lastAuthAt.get(trigger), policy.reauthWindowSec)) {
    if (trigger !== "spend" || spendGraceCovers(opts.amountUsdc)) {
      return { ok: true, ...base, outcome: "grace" };
    }
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
        recordAuth(trigger, Date.now(), opts.amountUsdc);
        return { ok: true, ...base, outcome: "granted" };
      }
      const cancelled =
        res.error === "user_cancel" || res.error === "app_cancel" || res.error === "system_cancel";
      return { ok: false, ...base, outcome: cancelled ? "cancelled" : "failed", note: res.error };
    }
    // No usable biometric hardware. Fall back to the app PIN if one is set, otherwise fail
    // closed: with no sensor and no PIN there is no way to prove it is the owner, so a
    // sensitive action is denied and the caller is told to set a PIN rather than waved through.
    if (await hasPin()) return runPinFlow(trigger, method, label, opts.amountUsdc);
    const note = "no biometric hardware and no PIN set; set a PIN to protect this action";
    console.warn(`[protection] ${trigger}: ${note}`);
    return { ok: false, ...base, outcome: "no_pin", note };
  }

  // method === "pin"
  return runPinFlow(trigger, method, label, opts.amountUsdc);
}

/** Guard a protection policy change. A change that weakens protection (a weaker method on any
 *  trigger, a higher spend threshold or a longer grace window) must be approved with the strongest
 *  factor already configured, so the barrier cannot be lowered without proving identity. A
 *  strengthening or equal change needs no proof. Callers persist the change only when `ok` is true. */
export async function authorizePolicyChange(
  current: ProtectionPolicy,
  next: ProtectionPolicy,
): Promise<AuthResult> {
  const challengeTrigger = strongestConfiguredTrigger(current);
  if (challengeTrigger === null || !isPolicyDowngrade(current, next)) {
    const trigger = challengeTrigger ?? "spend";
    return { ok: true, trigger, method: current.methods[trigger], outcome: "not_required" };
  }
  // A downgrade must be proven with a factor that was ALREADY established before this change was
  // requested. On a device with no pre-existing biometric, the only factor that can answer the
  // challenge is the app PIN. If that PIN was enrolled in THIS session through the unguarded
  // bootstrap path it is not a pre-existing owner factor, so it must not be allowed to weaken
  // protection. Refuse without prompting. Where a biometric is enrolled it is a genuine pre-existing
  // factor and the normal challenge runs. Where no factor was ever configured the branch above
  // already returned (nothing to downgrade), so this only bites when protection already exists.
  if (wasPinEnrolledThisSession() && !(await biometricAvailable())) {
    return {
      ok: false,
      trigger: challengeTrigger,
      method: current.methods[challengeTrigger],
      outcome: "failed",
      note: "a protection downgrade needs a factor set up before this change",
    };
  }
  return requireAuth(challengeTrigger, {
    policy: current,
    force: true,
    reason: "change your protection settings",
  });
}
