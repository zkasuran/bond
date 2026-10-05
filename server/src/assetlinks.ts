const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * The Digital Asset Links statement for one Android app, or null when not configured.
 * `certSha256` is one or more comma-separated SHA-256 signing-cert fingerprints in the
 * colon-separated hex form keytool prints. Malformed input yields null, never a
 * statement that would vouch for the wrong key.
 */
export function androidAssetLinks(pkg?: string, certSha256?: string): unknown[] | null {
  if (!pkg || !/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(pkg) || !certSha256) return null;
  const prints = certSha256.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);
  if (prints.length === 0 || !prints.every((p) => FINGERPRINT.test(p))) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
    },
  ];
}
