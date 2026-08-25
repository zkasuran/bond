# RevenueCat in an Expo (managed) React Native app, 2026

Research date: 2026-08-25. Target: Bond, Expo managed workflow, RevenueCat for
paywall plus free trial for the Shipaton submission. Every non-obvious fact below
is pinned to an official RevenueCat, Expo or Devpost URL. Where something is not
in the primary docs I say so instead of inventing it.

## Key decisions (the short version)

1. Use both packages: `react-native-purchases` (core SDK) and
   `react-native-purchases-ui` (RevenueCatUI: prebuilt paywalls plus Customer
   Center). Install with `npx expo install`.
2. There is no Expo config plugin to add. `react-native-purchases` ships no
   `app.plugin.js`, so nothing goes in the `plugins` array of `app.json`. The
   native modules are picked up by autolinking when you build a dev client or an
   EAS build. Expo Go cannot run real purchases, so a development build is
   mandatory.
3. Present a prebuilt paywall with one call: `RevenueCatUI.presentPaywall()` or
   `RevenueCatUI.presentPaywallIfNeeded({ requiredEntitlementIdentifier })`. Only
   drop to a custom UI (`getOfferings` plus `purchasePackage`) if the design needs
   it. The paywall is configured remotely in the dashboard.
4. For Shipaton, configure the free trial as an introductory offer on the real
   store product (App Store Connect or Play Console). During development use the
   RevenueCat Test Store, which needs no store products at all. Do not ship a
   build that carries a Test Store API key.

## Versions (verified against the npm registry on 2026-08-25)

- `react-native-purchases`: 10.7.2
- `react-native-purchases-ui`: 10.7.2 (kept in lockstep with the core version)
- Peer deps of the core package: `react >= 16.6.3`, `react-native >= 0.73.0`,
  `react-native-web: *`.
- Platform minimums the docs state: iOS deployment target 13.4, Android API 23
  (6.0), React Native 0.64 or higher. Note the current npm peer range is stricter
  (RN 0.73+), so treat 0.73 as the real floor for the current SDK.
- Minimum SDK versions for the Test Store: React Native 9.5.4 or newer (so any
  10.x is fine).

Pin exact versions in `package.json`. `npx expo install` will pick the version
that matches your Expo SDK, which is the recommended path over a bare
`npm install`.

## Package roles

- `react-native-purchases`: the core client. Wraps StoreKit, Google Play Billing
  and RevenueCat Billing. Configure the SDK, fetch offerings, make purchases,
  read entitlements.
- `react-native-purchases-ui`: the UI layer, exposed as `RevenueCatUI`. Ships
  prebuilt, remotely configurable paywalls (Paywalls v2) plus the Customer
  Center. One import gives you `presentPaywall`, `presentPaywallIfNeeded` and the
  `<RevenueCatUI.Paywall>` component.

## Expo managed workflow: what actually applies

Expo Go will not work for real purchases. The RevenueCat Expo install page states
the SDK "includes a built-in Preview API Mode specifically for Expo Go" that lets
you "preview subscription UIs, test integration flows, and continue development",
but "real purchases will not function in this mode". For real IAP you "must use a
development build". The Expo blog says the same thing in plainer words: "purchases
won't work in Expo Go because it doesn't include all the native APIs required
(it's a sandbox!)".

Config plugin: none is required. I checked the published tarball for
`react-native-purchases@10.7.2` and it contains no `app.plugin.js` or any Expo
plugin file. The RevenueCat Expo install doc never tells you to add anything
to a `plugins` array either. So you do not edit `app.json` for RevenueCat. The native
code is linked automatically during prebuild or EAS Build. (If a future version
adds a plugin the install doc would say so. Re-check the doc at build time.)

You do need `expo-dev-client` so you can run a custom development build instead of
Expo Go.

After adding the native modules a full rebuild is required. Hot reload alone
throws:

    Invariant Violation: `new NativeEventEmitter()` requires a non-null argument.

That error means the JS reloaded but the native module was never in the binary,
which is the tell that you tried to run it in Expo Go or without a fresh build.

### Install

```bash
# scaffold (skip if you already have the app)
npx create-expo-app@latest
cd <expo-project-directory>

# dev client so you can run a real build instead of Expo Go
npx expo install expo-dev-client

# the two RevenueCat packages
npx expo install react-native-purchases react-native-purchases-ui
```

### Build a dev client with EAS

```bash
eas login
eas init
eas build:configure
# then a platform build, for example:
eas build --profile development --platform ios
eas build --profile development --platform android
```

Install the resulting dev client on the device or simulator, then run
`npx expo start --dev-client`. EAS is the path the docs use because it needs no
local native toolchain. A local `npx expo run:ios` / `run:android` also works if
you have Xcode or Android Studio set up.

## API keys

Use the public SDK keys, one per platform, from Project Settings > API keys in the
dashboard. They are platform-prefixed:

- Apple / iOS: `appl_...`
- Google / Android: `goog_...`

Select the key by platform at configure time. Never put a RevenueCat secret key in
the app. For development you swap in the Test Store key (see the Test Store
section). You must switch back to the real platform key before you ship. The
docs are explicit: "Never submit an app to the App Store or Google Play that is
configured with a Test Store API key." A build-config or env-var split is the
recommended pattern: Test Store key in debug, platform key in release.

## SDK initialization

Configure once, as early as possible, before any offerings or purchases. Set the
log level first so you can see what the SDK is doing.

```javascript
import { Platform } from 'react-native';
import { useEffect } from 'react';
import Purchases, { LOG_LEVEL } from 'react-native-purchases';

const iosApiKey = 'appl_YOUR_KEY_HERE';
const androidApiKey = 'goog_YOUR_KEY_HERE';

export default function App() {
  useEffect(() => {
    Purchases.setLogLevel(LOG_LEVEL.VERBOSE); // use DEBUG or VERBOSE in dev
    if (Platform.OS === 'ios') {
      Purchases.configure({ apiKey: iosApiKey });
    } else if (Platform.OS === 'android') {
      Purchases.configure({ apiKey: androidApiKey });
    }
  }, []);
  // ...
}
```

Notes on this snippet:

- The iOS/Android split is exactly how the RevenueCat React Native codelab and the
  Expo install doc show it. The codelab wraps `configure` in a `try/catch` and
  gates the rest of the app on an `isConfigured` flag, which is the pattern to copy
  so offerings are never fetched before the SDK is ready.
- `configure` also accepts an `appUserID`. If you omit it the SDK generates an
  anonymous ID. Pass your own stable user ID when you have an account system so
  entitlements follow the user across devices. (The appUserID option is documented
  on the SDK reference rather than the pages I quoted here, so treat the exact call
  shape as "set apiKey plus appUserID in the configure object" and confirm against
  the SDK reference when you wire auth.)

## The data model: entitlements, offerings, packages

Three concepts, top down:

- Entitlement: the access level a customer is "entitled" to, like "pro" or
  "premium". Your app code checks entitlements, not product IDs. Scoped to the
  project, unlocked after a qualifying purchase.
- Offering: the set of products you present on a paywall, "the selection of
  products that are 'offered' to a user on your paywall". Offerings are optional
  but they unlock Paywalls, Experiments and Targeting. Each Offering pairs with a
  single configured paywall. One Offering is marked Default. That Default is what
  `getOfferings` returns as `offerings.current` when no other condition (Targeting
  or Experiment) applies.
- Package: lives inside an Offering. "A group of equivalent products across iOS,
  Android and web", so one Package holds the matching store product for each
  platform at the same duration and price tier. When you add a package you pick an
  identifier that matches its duration.

Package type constants (from the displaying-products doc, verbatim): `UNKNOWN`,
`CUSTOM`, `LIFETIME`, `ANNUAL`, `SIX_MONTH`, `THREE_MONTH`, `TWO_MONTH`,
`MONTHLY`, `WEEKLY`.

The flow at runtime: read `offerings.current`, iterate `availablePackages` or use
a duration convenience property like `offerings.current.monthly` /
`offerings.current.annual`. Get the underlying store product off a package through
its `product` (React Native) or the general `storeProduct` property.

## Fetching offerings

```javascript
import Purchases from 'react-native-purchases';

async function loadOffering() {
  try {
    const offerings = await Purchases.getOfferings();
    if (
      offerings.current !== null &&
      offerings.current.availablePackages.length !== 0
    ) {
      return offerings.current; // has packages to display
    }
    // no current offering: check the dashboard has a Default offering set
    return null;
  } catch (e) {
    console.error('Error fetching offerings', e);
    return null;
  }
}
```

The single most common setup error the codelab calls out is a project with no
"current" (Default) offering, which makes `offerings.current` null. Set a Default
offering in the dashboard.

You can also fetch by placement with
`Purchases.getCurrentOfferingForPlacement("your-placement-identifier")`. You can
also reach a specific offering by identifier via `offerings.all["your_offering_id"]`.

## Presenting a paywall: prebuilt vs custom

### Prebuilt (recommended, one line)

`react-native-purchases-ui` renders the paywall you designed in the dashboard, so
copy, pricing and layout update without an app release. Two entry points:

```typescript
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';

// Always show the paywall
async function presentPaywall(): Promise<boolean> {
  const result: PAYWALL_RESULT = await RevenueCatUI.presentPaywall();
  // or a specific offering:
  // const result = await RevenueCatUI.presentPaywall({ offering });

  switch (result) {
    case PAYWALL_RESULT.NOT_PRESENTED:
    case PAYWALL_RESULT.ERROR:
    case PAYWALL_RESULT.CANCELLED:
      return false;
    case PAYWALL_RESULT.PURCHASED:
    case PAYWALL_RESULT.RESTORED:
      return true;
    default:
      return false;
  }
}

// Show it only if the user lacks the entitlement (the usual gate)
async function gate() {
  const result = await RevenueCatUI.presentPaywallIfNeeded({
    requiredEntitlementIdentifier: 'pro',
    // offering, // optional Offering from getOfferings
  });
  return result;
}
```

`PAYWALL_RESULT` values: `NOT_PRESENTED`, `ERROR`, `CANCELLED`, `PURCHASED`,
`RESTORED`. `presentPaywallIfNeeded` checks the required entitlement for you and
does nothing if it is already active, which is why it is the natural call behind a
"go premium" button or a gated route.

### Prebuilt, embedded as a component

When you want the paywall inline in your own navigation rather than as a modal:

```jsx
import RevenueCatUI from 'react-native-purchases-ui';
import { View } from 'react-native';

function PaywallScreen({ offering, navigation }) {
  return (
    <View style={{ flex: 1 }}>
      <RevenueCatUI.Paywall
        options={{ offering }} // optional; omit to use the current offering
        onPurchaseCompleted={({ customerInfo }) => {
          // unlock, then leave
        }}
        onRestoreCompleted={({ customerInfo }) => {
          // may fire even if no entitlement was granted
        }}
        onDismiss={() => {
          // close button pressed, or a purchase succeeded
          navigation.goBack();
        }}
      />
    </View>
  );
}
```

Available listeners on the component: `onPurchaseStarted`, `onPurchaseCompleted`,
`onPurchaseError`, `onPurchaseCancelled`, `onRestoreStarted`,
`onRestoreCompleted`, `onRestoreError`, `onDismiss`. Note the doc warning that
`onRestoreCompleted` "may be called even if no entitlements have been granted", so
verify the entitlement inside the callback rather than assuming success.

### Custom UI

If the design does not fit the prebuilt paywall, build your own screen from
`getOfferings`, render each package, then call `purchasePackage` (see below). You
lose remote configurability but gain full control. Prefer the prebuilt paywall for
Shipaton unless there is a concrete reason not to, since it is judged on paywall
design and the dashboard editor is the fast path to a good one.

## Making a purchase manually (custom UI path)

```javascript
import Purchases from 'react-native-purchases';

async function buy(pkg) {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    if (typeof customerInfo.entitlements.active['pro'] !== 'undefined') {
      // unlock "pro" content
    }
  } catch (e) {
    if (!e.userCancelled) {
      // real error, surface it
      console.error(e);
    }
    // e.userCancelled === true means the user backed out, not an error
  }
}
```

The cancel case is detected with `e.userCancelled` in the React Native SDK. (An
error-code form, `PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR`, exists but the
docs show that variant for Capacitor, so prefer `e.userCancelled` here.)

For products outside offerings you can use `Purchases.getProducts([ids])` then
`Purchases.purchaseStoreProduct(product)`.

## Checking entitlement

```javascript
import Purchases from 'react-native-purchases';

const ENTITLEMENT_ID = 'pro';

async function isPro() {
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    return typeof customerInfo.entitlements.active[ENTITLEMENT_ID] !== 'undefined';
    // equivalently: customerInfo.entitlements.active[ENTITLEMENT_ID]?.isActive
  } catch (e) {
    return false;
  }
}
```

`getCustomerInfo` is cached and cheap to call. For reactive UI the RN SDK also
exposes a customer-info update listener
(`Purchases.addCustomerInfoUpdateListener(info => ...)`) so gated screens re-render
when entitlements change. I did not fetch a page that quotes that exact method
signature in this pass, so confirm the listener name against the SDK reference when
you wire it, but the listener pattern itself is standard.

## Restoring purchases

```javascript
import Purchases from 'react-native-purchases';

async function restore() {
  try {
    const customerInfo = await Purchases.restorePurchases();
    if (typeof customerInfo.entitlements.active['pro'] !== 'undefined') {
      // entitlement is back, unlock
    }
  } catch (e) {
    // handle restore failure
  }
}
```

Rules from the docs:

- Every app "should have some way for users to trigger the `restorePurchases`
  method, even if you require all customers to create accounts". Apple requires a
  visible restore path, so ship a "Restore purchases" button.
- Call it only from an explicit user action. It can trigger an OS-level store
  sign-in prompt, so do not call it on launch. For silent background re-syncing use
  `syncPurchases` instead.
- Restore re-syncs purchases made from the same store account. Consumables and
  non-renewing products can only be restored if you use your own App User IDs
  (an account system), because they do not stay on the store receipt.

## Free trials and introductory offers (and the Shipaton rule)

The Shipaton submission rule, from the RevenueCat Ship-a-ton Devpost: "App must
either offer a free trial or the submission must include a promo code for judges
to unlock the in-app purchases for testing all premium features." So a free trial
is one of two ways to satisfy the requirement, the other being a judge promo code.
The 2026 build window is August 1 to September 30, 2026. Confirm the exact 2026
clause on the official rules page before submitting, since I quoted the Ship-a-ton
Devpost wording and the 2026 rules page is separate (both linked in Sources).

How trials actually work with RevenueCat:

- A free trial is an introductory offer configured on the store product itself, in
  App Store Connect (iOS) or Google Play Console (Android). RevenueCat does not
  create the trial. It detects and applies it.
- Apple and Amazon: "when an eligible user attempts to purchase a product that has
  an introductory offer (e.g. a free trial) the offer will be applied
  automatically". This is "outside of the control of RevenueCat's Purchases SDK".
- Google Play: the SDK selects the offer when you pass a `Package` or
  `StoreProduct`. Its logic is: longest free trial the customer qualifies for,
  else the cheapest eligible introductory period, else the base plan. To stop a
  developer-determined offer from being auto-selected, tag it `rc-ignore-offer` in
  Play Console.
- iOS eligibility: new subscribers always qualify. Lapsed subscribers qualify if
  they have not already used an intro offer for that product or any product in the
  same subscription group. Upgrades, downgrades and crossgrades inside a group do
  not qualify. RevenueCat does a best-effort eligibility check and the native
  payment sheet is the final authority. Eligibility checking is iOS only.
- The prebuilt paywall renders the trial automatically. When the offering's
  product carries an intro offer, the RevenueCatUI paywall shows the trial terms,
  so choosing the prebuilt paywall plus a store-configured trial is the least-code
  way to meet the Shipaton free-trial requirement.
- Store propagation can take up to 24 hours after you add an offer, so configure
  the trial early. If an expected trial does not show, check the store account has
  not already consumed that product's intro offer.

One caution I could not verify: whether the RevenueCat Test Store can simulate a
free trial. The Test Store docs describe products (identifier, duration, price)
and renewal simulation but do not mention introductory offers, so do not assume
you can demo the trial purely in the Test Store. Plan to configure the real
introductory offer on the store product for the judged build.

## The Test Store (develop without store products)

The Test Store is RevenueCat's built-in testing environment, "automatically
provisioned with every new project". It needs no App Store or Play Console
products: it "works automatically with the RevenueCat SDK, no additional
configuration is required beyond using your Test Store API key". Test purchases
"behave like real purchases and subscriptions", updating CustomerInfo, triggering
entitlements and showing in the dashboard.

- Create products in the Products tab, attach them to an Offering in the Offerings
  tab. Products are fixed at creation: identifier, duration and price cannot be
  edited later. To change one, make a new product, swap it into the package then
  archive the old one.
- On a purchase the SDK presents a modal with the product metadata and buttons to
  simulate a successful purchase, a failed purchase or a cancel. Good for testing
  each code path and for automated integration tests.
- Test subscriptions renew automatically up to 5 times, then cancel and the
  entitlement goes inactive. Weekly and monthly renew every 5 minutes, longer
  durations scale up (2 month every 10 min, 3 month every 15 min, 6 month every 30
  min, 1 year every hour).
- Minimum SDK for the Test Store on React Native is 9.5.4.
- Switch to the real platform API key for any store build. Never submit a build
  configured with a Test Store API key.

Use the Test Store to build and demo the whole paywall and entitlement flow before
you have live store products, which is the fastest way to a working end-to-end
loop during the hackathon.

## Gotchas worth pinning

- Expo Go only ever mocks purchases (Preview API Mode). A real flow needs a dev
  client / EAS build. The `NativeEventEmitter ... requires a non-null argument`
  crash is the signature of running the native module where it was not compiled in.
- `offerings.current` null almost always means no Default offering is set in the
  dashboard.
- `onRestoreCompleted` can fire with no entitlement granted. Verify inside the
  callback.
- Do not call `restorePurchases` on launch. It can pop a store sign-in.
- Keep the Test Store key out of release builds.
- `npx expo install` (not bare `npm install`) so the RevenueCat versions match
  your Expo SDK.

## Sources (official)

- Expo install guide (packages, Preview API Mode, dev build required, configure
  snippet, entitlement check):
  https://www.revenuecat.com/docs/getting-started/installation/expo
- React Native install guide (peer platform minimums, Android BILLING permission,
  launchMode note): https://www.revenuecat.com/docs/getting-started/installation/reactnative
- React Native SDK codelab, 2026 (full configure / getOfferings / paywall /
  entitlement flow): https://revenuecat.github.io/codelabs/react-native.html
- Expo blog tutorial (Expo Go sandbox limitation, `npx expo install`, dev client):
  https://expo.dev/blog/expo-revenuecat-in-app-purchase-tutorial
- Displaying paywalls with RevenueCatUI (presentPaywall, presentPaywallIfNeeded,
  PAYWALL_RESULT, component listeners):
  https://www.revenuecat.com/docs/tools/paywalls/displaying-paywalls
- Offerings overview (offering, package, default/current model):
  https://www.revenuecat.com/docs/offerings/overview
- Displaying products (getOfferings usage, package type constants,
  availablePackages): https://www.revenuecat.com/docs/getting-started/displaying-products
- Making purchases (purchasePackage, userCancelled):
  https://www.revenuecat.com/docs/getting-started/making-purchases
- Restoring purchases (restorePurchases, syncPurchases, restore button guidance):
  https://www.revenuecat.com/docs/getting-started/restoring-purchases
- Entitlements (access-level model):
  https://www.revenuecat.com/docs/getting-started/entitlements
- Subscription offers (auto-applied trials, iOS eligibility, Google selection
  logic, rc-ignore-offer):
  https://www.revenuecat.com/docs/subscription-guidance/subscription-offers
- Google Play offers (rc-ignore-offer detail):
  https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/google-play-offers
- Test Store (auto-provisioned, Test API key, simulate purchase, renewal timing,
  min SDK): https://www.revenuecat.com/docs/test-and-launch/sandbox/test-store
- Sandbox overview: https://www.revenuecat.com/docs/test-and-launch/sandbox
- SDK reference site (react-native-purchases API):
  https://revenuecat.github.io/react-native-purchases-docs/
- GitHub repo: https://github.com/RevenueCat/react-native-purchases
- npm (versions verified 2026-08-25): https://www.npmjs.com/package/react-native-purchases
  and https://www.npmjs.com/package/react-native-purchases-ui
- Shipaton 2026 rules: https://revenuecat-shipaton-2026.devpost.com/rules
- Shipaton free-trial-or-promo-code requirement (Ship-a-ton Devpost):
  https://revenuecat-ship-a-ton.devpost.com/
- Shipaton 2026 prep codelab (build window Aug 1 to Sep 30):
  https://revenuecat.github.io/codelabs/shipaton-2026-prep.html
