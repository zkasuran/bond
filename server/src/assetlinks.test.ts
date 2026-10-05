import { test } from "node:test";
import assert from "node:assert/strict";
import { androidAssetLinks } from "./assetlinks.js";

const FP = "BB:4F:34:37:FD:B2:FF:35:07:CB:84:3C:4C:45:B6:90:FE:EE:5B:18:0C:99:E5:B2:E0:9F:88:FA:14:55:22:C1";

test("builds one statement for a valid package and fingerprint", () => {
  const out = androidAssetLinks("com.zkasuran.bond", FP.toLowerCase()) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
  assert.equal(out.length, 1);
  assert.equal(out[0]!.target.package_name, "com.zkasuran.bond");
  assert.deepEqual(out[0]!.target.sha256_cert_fingerprints, [FP]);
});

test("returns null when unset or malformed, never a statement for a bad key", () => {
  assert.equal(androidAssetLinks(undefined, FP), null);
  assert.equal(androidAssetLinks("com.zkasuran.bond", undefined), null);
  assert.equal(androidAssetLinks("com.zkasuran.bond", "BB:4F"), null);
  assert.equal(androidAssetLinks("not a package", FP), null);
  assert.equal(androidAssetLinks("com.zkasuran.bond", `${FP},nope`), null);
});
