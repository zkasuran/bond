// Plans, entitlement and free-tier gating. App code checks a single entitlement id
// ("pro") and never a product id, so pricing and product setup can change in the
// RevenueCat dashboard without touching the client. See DESIGN.md sec 7.

/** The one entitlement the app ever checks. Products map to it in the dashboard. */
export const PRO_ENTITLEMENT = "pro";

// Free-tier caps. Pro removes all three: unlimited rooms, every bridge connected at
// once, multiple agents per room and unlimited runs.
export const FREE_ROOMS = 2;
export const FREE_BRIDGES = 1;
export const FREE_MONTHLY_RUNS = 50;

/** The kinds of action the free tier meters. */
export type GateKind = "room" | "bridge" | "run";

export interface GateResult {
  /** True if the action is allowed under the current plan. */
  allowed: boolean;
  /** Empty when allowed. When blocked, a plain message for the paywall prompt. */
  reason: string;
}

const FREE_CAP: Record<GateKind, number> = {
  room: FREE_ROOMS,
  bridge: FREE_BRIDGES,
  run: FREE_MONTHLY_RUNS,
};

const LIMIT_REASON: Record<GateKind, string> = {
  room: `The free plan is limited to ${FREE_ROOMS} rooms. Upgrade to Pro for unlimited rooms.`,
  bridge: `The free plan connects ${FREE_BRIDGES} bridge at a time. Upgrade to Pro to use every bridge at once.`,
  run: `The free plan includes ${FREE_MONTHLY_RUNS} agent runs per month. Upgrade to Pro for unlimited runs.`,
};

/**
 * Decide whether one more action of `kind` is allowed.
 *
 * `currentCount` is how many already exist (rooms, connected bridges) or have been
 * used this month (runs). Pro is never capped. On the free tier the action is allowed
 * while the count is still under the cap, so a caller passing the current total gets a
 * yes until the cap is reached, then a no with a reason to show on the paywall.
 */
export function gate(kind: GateKind, currentCount: number, isPro: boolean): GateResult {
  if (isPro) {
    return { allowed: true, reason: "" };
  }
  if (currentCount < FREE_CAP[kind]) {
    return { allowed: true, reason: "" };
  }
  return { allowed: false, reason: LIMIT_REASON[kind] };
}
