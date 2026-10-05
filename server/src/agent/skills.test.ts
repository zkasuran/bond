import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  PAID_SKILLS,
  isValidLicense,
  minAuthorBaseUnits,
  parseClaims,
  skillInstructions,
  skillTools,
  usdcReceived,
  labelFor,
  skillPurchasesIn,
  PLATFORM_WALLET,
} from "./skills.js";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// A real devnet purchase of usdc-price-watcher (0.40 to the creator, 0.10 to the platform).
const purchase = JSON.parse(
  readFileSync(new URL("./fixtures-purchase-tx.json", import.meta.url), "utf8"),
) as ParsedTransactionWithMeta;
const SIG = "3juk7KVZru82hsTvi7boRSmZaiYmBWNV3ZvqiJSxwiZbWF4JezgRQo2wUd3TvNUVeGDSENmKb8q7uxoJV6sfJwq5";

test("a real purchase licenses the skill it paid for", () => {
  const skill = PAID_SKILLS["usdc-price-watcher"]!;
  assert.equal(usdcReceived(purchase, skill.authorWallet, USDC), 400_000n);
  assert.equal(isValidLicense(purchase, skill, USDC), true);
});

test("the same payment does not license a different or pricier skill", () => {
  assert.equal(isValidLicense(purchase, PAID_SKILLS["wallet-summarizer"]!, USDC), false);
  assert.equal(isValidLicense(purchase, PAID_SKILLS["tx-explainer"]!, USDC), false);
});

test("a failed, missing or wrong-mint transaction licenses nothing", () => {
  const skill = PAID_SKILLS["usdc-price-watcher"]!;
  const failed = { ...purchase, meta: { ...purchase.meta!, err: { InstructionError: [0, "Custom"] } } };
  assert.equal(isValidLicense(failed as ParsedTransactionWithMeta, skill, USDC), false);
  assert.equal(isValidLicense(null, skill, USDC), false);
  assert.equal(isValidLicense(purchase, skill, "So11111111111111111111111111111111111111112"), false);
});

test("the minimum honours the maximum creator SKR discount", () => {
  // 0.50 USDC price, 80% creator cut = 0.40, less up to 25% SKR discount = 0.30.
  assert.equal(minAuthorBaseUnits(PAID_SKILLS["usdc-price-watcher"]!), 300_000n);
});

test("parseClaims keeps only well-formed claims for known skills, deduped and capped", () => {
  const claims = parseClaims([
    { id: "usdc-price-watcher", signature: SIG },
    { id: "usdc-price-watcher", signature: SIG },
    { id: "not-a-skill", signature: SIG },
    { id: "translator", signature: "short" },
    { id: 7, signature: SIG },
    "junk",
  ]);
  assert.deepEqual(claims, [{ id: "usdc-price-watcher", signature: SIG }]);
  assert.deepEqual(parseClaims("nope"), []);
});

test("only unlocked skills contribute tools or instructions", () => {
  const none = skillTools([], {} as never);
  assert.deepEqual(Object.keys(none), []);
  const some = skillTools(["usdc-price-watcher", "tx-explainer"], {} as never);
  assert.deepEqual(Object.keys(some).sort(), ["skill_explain_transaction", "skill_usdc_price"]);
  assert.equal(skillInstructions([]).length, 0);
  assert.equal(skillInstructions(["translator"]).length, 1);
});

test("the explainer recognises a marketplace purchase and labels the parties", () => {
  assert.deepEqual(skillPurchasesIn(purchase, USDC), ["USDC Price Watcher"]);
  assert.equal(labelFor(PLATFORM_WALLET), "Bond platform fee wallet");
  assert.equal(labelFor(PAID_SKILLS["usdc-price-watcher"]!.authorWallet), "Orbit Labs, creator of USDC Price Watcher");
  assert.equal(labelFor("11111111111111111111111111111111"), undefined);
  assert.deepEqual(skillPurchasesIn(purchase, "So11111111111111111111111111111111111111112"), []);
});
