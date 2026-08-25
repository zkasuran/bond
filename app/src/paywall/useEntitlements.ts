// Entitlement store. A small zustand store the UI reads to decide free vs pro. It
// configures RevenueCat once, reads the current customer info and then tracks live
// updates from the SDK, so a purchase or a restore flips `isPro` without a manual
// refresh. On web or in Expo Go every underlying call is a no-op, so the store simply
// settles on isPro=false with ready=true and the app loads normally. See DESIGN.md sec 7.
import { create } from "zustand";
import {
  configureRevenueCat,
  getCustomerInfo,
  isPro as checkPro,
  subscribeToCustomerInfo,
} from "./revenuecat";

interface EntitlementState {
  /** Whether the "pro" entitlement is active. */
  isPro: boolean;
  /** True once the first entitlement check has finished (success or no-op). */
  ready: boolean;
  /** Re-read customer info on demand, for example after returning to the foreground. */
  refresh: () => Promise<void>;
  /** Configure the SDK, read the first customer info and subscribe to updates. */
  init: () => Promise<void>;
}

// Held outside the store so a second init() replaces the listener instead of stacking.
let unsubscribe: (() => void) | null = null;

export const useEntitlements = create<EntitlementState>((set) => ({
  isPro: false,
  ready: false,

  async refresh() {
    const info = await getCustomerInfo();
    set({ isPro: checkPro(info) });
  },

  async init() {
    await configureRevenueCat();
    const info = await getCustomerInfo();
    set({ isPro: checkPro(info), ready: true });

    if (unsubscribe) unsubscribe();
    unsubscribe = await subscribeToCustomerInfo((next) => {
      set({ isPro: checkPro(next) });
    });
  },
}));
