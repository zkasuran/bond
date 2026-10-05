const { withAppBuildGradle } = require("expo/config-plugins");

// Signs the Android release build with a real upload key instead of the debug
// keystore Expo's template uses. The key lives outside the repo; Gradle reads its
// path and password from the environment at build time:
//   BOND_KEYSTORE, BOND_KEYSTORE_ALIAS, BOND_KEYSTORE_PASSWORD
// When BOND_KEYSTORE is unset the build falls back to debug signing, so local
// development and CI without the key still work.
const MARKER = "// bond-release-signing";

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(MARKER)) return cfg;

    src = src.replace(
      /signingConfigs\s*\{/,
      `signingConfigs {
        ${MARKER}
        release {
            if (System.getenv("BOND_KEYSTORE")) {
                storeFile file(System.getenv("BOND_KEYSTORE"))
                storePassword System.getenv("BOND_KEYSTORE_PASSWORD")
                keyAlias System.getenv("BOND_KEYSTORE_ALIAS") ?: "bond"
                keyPassword System.getenv("BOND_KEYSTORE_PASSWORD")
            }
        }`,
    );
    // In the release buildType only, switch to the release config when the key is present.
    src = src.replace(
      /(release\s*\{[^{}]*?)signingConfig signingConfigs\.debug/,
      `$1signingConfig System.getenv("BOND_KEYSTORE") ? signingConfigs.release : signingConfigs.debug`,
    );
    cfg.modResults.contents = src;
    return cfg;
  });
};
