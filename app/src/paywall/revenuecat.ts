// RevenueCat wrapper. Every native call is guarded so the module loads and degrades to
// a free (non pro) experience on web, in Expo Go or whenever the native SDK is missing,
// rather than throwing at import or call time. Purchases needs a development build to run
// real purchases: Expo Go and the web bundle both fall through to the no-op path here.
// The API key is a platform key read at runtime, never a Test Store key baked into a
// production build. See DESIGN.md sec 7.
import { Platform } from "react-native";
import type { CustomerInfo, PurchasesOffering } from "react-native-purchases";
import type { PAYWALL_RESULT } from "react-native-purchases-ui";
import { PRO_ENTITLEMENT } from "./plans";

type PurchasesModule = typeof import("react-native-purchases").default;
type RevenueCatUIModule = typeof import("react-native-purchases-ui").default;
type PaywallResultEnum = typeof import("react-native-purchases-ui").PAYWALL_RESULT;

/** Normalized outcome of showing a paywall. "unavailable" means the surface never ran. */
export type PaywallOutcome =
  | "purchased"
  | "restored"
  | "cancelled"
  | "not_presented"
  | "error"
  | "unavailable";

// Platform keys. Only the Android key is required by the spec, the iOS one follows the
// same pattern. Neutral env constants with empty defaults so a missing key is a no-op
// rather than a crash. Keys are configured at runtime, not committed.
const ANDROID_KEY = process.env.EXPO_PUBLIC_RC_ANDROID_KEY ?? "";
const IOS_KEY = process.env.EXPO_PUBLIC_RC_IOS_KEY ?? "";

// Cached module references after a successful dynamic import. Null until loaded and it
// stays null wherever the SDK cannot run.
let purchasesMod: PurchasesModule | null = null;
let uiMod: RevenueCatUIModule | null = null;
let paywallResult: PaywallResultEnum | null = null;
let configured = false;

/** Purchases and the prebuilt paywall UI only run on the native iOS or Android builds. */
function nativeAvailable(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

function platformKey(): string {
  return Platform.OS === "ios" ? IOS_KEY : ANDROID_KEY;
}

async function loadPurchases(): Promise<PurchasesModule | null> {
  if (!nativeAvailable()) return null;
  if (purchasesMod) return purchasesMod;
  try {
    const mod = await import("react-native-purchases");
    purchasesMod = mod.default;
    return purchasesMod;
  } catch {
    return null;
  }
}

async function loadUI(): Promise<RevenueCatUIModule | null> {
  if (!nativeAvailable()) return null;
  if (uiMod) return uiMod;
  try {
    const mod = await import("react-native-purchases-ui");
    uiMod = mod.default;
    paywallResult = mod.PAYWALL_RESULT;
    return uiMod;
  } catch {
    return null;
  }
}

function toOutcome(result: PAYWALL_RESULT): PaywallOutcome {
  const kinds = paywallResult;
  if (!kinds) return "unavailable";
  switch (result) {
    case kinds.PURCHASED:
      return "purchased";
    case kinds.RESTORED:
      return "restored";
    case kinds.CANCELLED:
      return "cancelled";
    case kinds.NOT_PRESENTED:
      return "not_presented";
    default:
      return "error";
  }
}

/**
 * Configure the SDK with the platform key. `apiKey` defaults to the runtime env key for
 * the current platform. Returns false, without throwing, when the SDK cannot run or no
 * key is present, so the app stays on the free tier. Safe to call more than once.
 */
export async function configureRevenueCat(apiKey: string = platformKey()): Promise<boolean> {
  const Purchases = await loadPurchases();
  if (!Purchases) return false;
  if (configured) return true;
  if (!apiKey) return false;
  try {
    Purchases.configure({ apiKey });
    configured = true;
    return true;
  } catch {
    return false;
  }
}

/** The current offering or null when offerings cannot be fetched. */
export async function getOfferings(): Promise<PurchasesOffering | null> {
  const Purchases = await loadPurchases();
  if (!Purchases) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current ?? null;
  } catch {
    return null;
  }
}

/** Latest customer info or null when it cannot be fetched. */
export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  const Purchases = await loadPurchases();
  if (!Purchases) return null;
  try {
    return await Purchases.getCustomerInfo();
  } catch {
    return null;
  }
}

/** True when the "pro" entitlement is active. False for null or a free customer. */
export function isPro(customerInfo: CustomerInfo | null | undefined): boolean {
  if (!customerInfo) return false;
  return typeof customerInfo.entitlements.active[PRO_ENTITLEMENT] !== "undefined";
}

/** Present the prebuilt paywall for the current offering or a specific one if passed. */
export async function presentPaywall(
  offering?: PurchasesOffering | null,
): Promise<PaywallOutcome> {
  const RevenueCatUI = await loadUI();
  if (!RevenueCatUI) return "unavailable";
  try {
    const result = offering
      ? await RevenueCatUI.presentPaywall({ offering })
      : await RevenueCatUI.presentPaywall();
    return toOutcome(result);
  } catch {
    return "error";
  }
}

/** Present the paywall only if the entitlement is not already active. */
export async function presentPaywallIfNeeded(
  requiredEntitlementIdentifier: string = PRO_ENTITLEMENT,
  offering?: PurchasesOffering | null,
): Promise<PaywallOutcome> {
  const RevenueCatUI = await loadUI();
  if (!RevenueCatUI) return "unavailable";
  try {
    const result = offering
      ? await RevenueCatUI.presentPaywallIfNeeded({ requiredEntitlementIdentifier, offering })
      : await RevenueCatUI.presentPaywallIfNeeded({ requiredEntitlementIdentifier });
    return toOutcome(result);
  } catch {
    return "error";
  }
}

/** Restore prior purchases. Returns the resulting pro state and customer info. */
export async function restore(): Promise<{ isPro: boolean; customerInfo: CustomerInfo | null }> {
  const Purchases = await loadPurchases();
  if (!Purchases) return { isPro: false, customerInfo: null };
  try {
    const customerInfo = await Purchases.restorePurchases();
    return { isPro: isPro(customerInfo), customerInfo };
  } catch {
    return { isPro: false, customerInfo: null };
  }
}

/**
 * Subscribe to customer info updates. Returns an unsubscribe function. When the SDK is
 * unavailable the listener never fires and unsubscribe is a no-op.
 */
export async function subscribeToCustomerInfo(
  listener: (customerInfo: CustomerInfo) => void,
): Promise<() => void> {
  const Purchases = await loadPurchases();
  if (!Purchases) return () => {};
  try {
    Purchases.addCustomerInfoUpdateListener(listener);
    return () => {
      try {
        Purchases.removeCustomerInfoUpdateListener(listener);
      } catch {
        // Removing a listener after teardown is harmless.
      }
    };
  } catch {
    return () => {};
  }
}
