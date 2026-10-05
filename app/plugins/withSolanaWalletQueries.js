const { withAndroidManifest } = require("expo/config-plugins");

// Mobile Wallet Adapter discovery on Android 11+ depends on the app declaring that
// it will query for wallet apps handling the solana-wallet scheme. Without this
// <queries> entry, package visibility hides every wallet and MWA cannot connect.
// Continuous Native Generation rewrites android/ on each prebuild, so this has to be
// a config plugin rather than a hand edit to the manifest.
const SOLANA_WALLET_SCHEME = "solana-wallet";

module.exports = function withSolanaWalletQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries || [];

    const alreadyDeclared = manifest.queries.some((q) =>
      (q.intent || []).some((intent) =>
        (intent.data || []).some(
          (d) => d && d.$ && d.$["android:scheme"] === SOLANA_WALLET_SCHEME,
        ),
      ),
    );

    if (!alreadyDeclared) {
      manifest.queries.push({
        intent: [
          {
            action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
            category: [
              { $: { "android:name": "android.intent.category.BROWSABLE" } },
            ],
            data: [{ $: { "android:scheme": SOLANA_WALLET_SCHEME } }],
          },
        ],
      });
    }

    return cfg;
  });
};
