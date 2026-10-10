import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  PAID_SKILLS,
  type PaidSkill,
  isValidLicense,
  minAuthorBaseUnits,
  minPlatformBaseUnits,
  parseClaims,
  skillInstructions,
  skillTools,
  usdcReceived,
  labelFor,
  skillPurchasesIn,
  verifyClaims,
  verifyClaimProof,
  issueSkillChallenge,
  verifySkillChallenge,
  base58Encode,
  PLATFORM_WALLET,
} from "./skills.js";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// A real devnet purchase of usdc-price-watcher (0.40 to the creator, 0.10 to the platform).
const purchase = JSON.parse(
  readFileSync(new URL("./fixtures-purchase-tx.json", import.meta.url), "utf8"),
) as ParsedTransactionWithMeta;
const SIG = "3juk7KVZru82hsTvi7boRSmZaiYmBWNV3ZvqiJSxwiZbWF4JezgRQo2wUd3TvNUVeGDSENmKb8q7uxoJV6sfJwq5";
// The wallet whose USDC balance dropped in the fixture: the real payer.
const BUYER = "Hk26Gxs8zrZ5dCfBQsePwpzZpYvXLDx5A3GrrMhBZYW9";
// A valid base58 address that is not party to the fixture: a would-be replayer.
const OTHER = "HCz5osKHHCjtcx23jHo7A8v1u7vmt9wEzACRYKqBFJds";

// --- wallet-ownership proof helpers (F14 HIGH) ----------------------------------------------
// Generate an Ed25519 keypair and expose its raw 32-byte public key plus a signer, so a test
// can play the role of a real wallet or device did:key and produce genuine signatures.
function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"));
  return { raw, sign: (msg: Uint8Array) => new Uint8Array(nodeSign(null, Buffer.from(msg), privateKey)) };
}
const b64url = (u: Uint8Array) => Buffer.from(u).toString("base64url");
const enc = (s: string) => new TextEncoder().encode(s);

// Build a complete, genuine proof bundle: a fresh wallet keypair pays, a fresh device did:key
// is bound to it, and the did signs a fresh challenge over the claim. Returns the payer address
// and the proof the client would send.
function makeProofBundle(skillId: string, txSig = SIG, now = Date.now()) {
  const wallet = makeKey();
  const device = makeKey();
  const walletAddress = base58Encode(wallet.raw);
  const didPayload = new Uint8Array(34);
  didPayload[0] = 0xed;
  didPayload[1] = 0x01;
  didPayload.set(device.raw, 2);
  const did = "did:key:z" + base58Encode(didPayload);

  const bindingFields = {
    did,
    walletAddress,
    nonce: "0".repeat(32),
    context: "bond:wallet-did-binding:v1",
    version: 1,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  };
  const bindingMsg = enc(
    [
      "Bond wallet binding v1",
      `context: ${bindingFields.context}`,
      `did: ${bindingFields.did}`,
      `wallet: ${bindingFields.walletAddress}`,
      `nonce: ${bindingFields.nonce}`,
      `version: ${bindingFields.version}`,
      `issued: ${bindingFields.issuedAt}`,
      `expires: ${bindingFields.expiresAt}`,
    ].join("\n"),
  );
  const binding = {
    ...bindingFields,
    walletSignature: b64url(wallet.sign(bindingMsg)),
    didSignature: b64url(device.sign(bindingMsg)),
  };

  const challenge = issueSkillChallenge(now);
  const claimMsg = enc(
    [
      "Bond skill claim v1",
      `skill: ${skillId}`,
      `tx: ${txSig}`,
      `buyer: ${walletAddress}`,
      `challenge: ${challenge}`,
    ].join("\n"),
  );
  const didSig = b64url(device.sign(claimMsg));
  return { walletAddress, did, challenge, proof: { challenge, did, didSig, binding } };
}

// A synthetic confirmed transaction: `buyer` spends `spent` USDC and each owner in `receives`
// is credited. Only the fields the license rule reads are populated.
function synthTx(buyer: string, receives: Record<string, bigint>, spent: bigint, mint: string): ParsedTransactionWithMeta {
  const bal = (owner: string, amount: bigint) => ({
    accountIndex: 0,
    owner,
    mint,
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: null, uiAmountString: String(amount) },
  });
  const owners = Object.keys(receives);
  return {
    meta: {
      err: null,
      preTokenBalances: [bal(buyer, spent), ...owners.map((o) => bal(o, 0n))],
      postTokenBalances: [bal(buyer, 0n), ...owners.map((o) => bal(o, receives[o]!))],
    },
  } as unknown as ParsedTransactionWithMeta;
}

// A synthetic transaction that honestly licenses `skill` for `buyer` at full price.
function synthLicenseTx(buyer: string, skill: PaidSkill, mint: string): ParsedTransactionWithMeta {
  const author = (skill.priceBaseUnits * 8000n) / 10_000n;
  const platform = skill.priceBaseUnits - author;
  return synthTx(buyer, { [skill.authorWallet]: author, [PLATFORM_WALLET]: platform }, skill.priceBaseUnits, mint);
}


test("a real purchase licenses the skill it paid for", () => {
  const skill = PAID_SKILLS["usdc-price-watcher"]!;
  assert.equal(usdcReceived(purchase, skill.authorWallet, USDC), 400_000n);
  assert.equal(isValidLicense(purchase, skill, USDC, BUYER), true);
});

test("a purchase signature does not license a buyer who did not pay", () => {
  const skill = PAID_SKILLS["usdc-price-watcher"]!;
  // The payer is licensed, a different buyer replaying the same public signature is not.
  assert.equal(isValidLicense(purchase, skill, USDC, BUYER), true);
  assert.equal(isValidLicense(purchase, skill, USDC, OTHER), false);
});

test("a payment that skips the platform fee licenses nothing", () => {
  const skill = PAID_SKILLS["usdc-price-watcher"]!;
  const noPlatform = {
    ...purchase,
    meta: {
      ...purchase.meta!,
      postTokenBalances: (purchase.meta!.postTokenBalances ?? []).filter((b) => b.owner !== PLATFORM_WALLET),
    },
  } as ParsedTransactionWithMeta;
  assert.equal(isValidLicense(noPlatform, skill, USDC, BUYER), false);
  assert.equal(isValidLicense(purchase, skill, USDC, BUYER), true);
});

test("verifyClaimProof accepts a genuine payer proof and rejects a bare-payer claim (F14 HIGH)", () => {
  const { walletAddress, proof } = makeProofBundle("wallet-summarizer");
  // A genuine proof from the real payer is accepted.
  assert.equal(verifyClaimProof({ id: "wallet-summarizer", signature: SIG, buyer: walletAddress, proof }), true);
  // The exact V11 bypass: name the payer, carry no proof. Rejected.
  assert.equal(verifyClaimProof({ id: "wallet-summarizer", signature: SIG, buyer: walletAddress }), false);
});

test("verifyClaimProof rejects a proof whose binding wallet is not the named payer", () => {
  const { proof } = makeProofBundle("wallet-summarizer");
  // An explorer reader pairs a stranger's binding with the real payer's address: both the
  // binding wallet mismatch and the claim-message mismatch fail it.
  assert.equal(verifyClaimProof({ id: "wallet-summarizer", signature: SIG, buyer: OTHER, proof }), false);
});

test("verifyClaimProof rejects a stale challenge and a tampered binding signature", () => {
  // A challenge issued well outside the window no longer verifies, so the proof is rejected.
  const stale = makeProofBundle("wallet-summarizer", SIG, Date.now() - 10 * 60 * 1000);
  assert.equal(verifyClaimProof({ id: "wallet-summarizer", signature: SIG, buyer: stale.walletAddress, proof: stale.proof }), false);
  // A fresh proof with the wallet signature flipped to the did signature (so the wallet leg no
  // longer verifies against the wallet key) is rejected.
  const fresh = makeProofBundle("wallet-summarizer");
  const tampered = {
    ...fresh.proof,
    binding: { ...fresh.proof.binding, walletSignature: fresh.proof.binding.didSignature },
  };
  assert.equal(verifyClaimProof({ id: "wallet-summarizer", signature: SIG, buyer: fresh.walletAddress, proof: tampered }), false);
});

test("verifyClaims unlocks the proven payer, rejects the bare-payer bypass and a replayer, cache does not leak (F14 HIGH)", async () => {
  const skillId = "wallet-summarizer";
  const skill = PAID_SKILLS[skillId]!;
  const payer = makeProofBundle(skillId);
  const tx = synthLicenseTx(payer.walletAddress, skill, USDC);
  const conn = { getParsedTransaction: async () => tx } as unknown as Connection;

  // A genuine payer proof unlocks (and caches the on-chain license fact).
  assert.deepEqual(
    await verifyClaims(conn, [{ id: skillId, signature: SIG, buyer: payer.walletAddress, proof: payer.proof }], USDC),
    [skillId],
  );
  // The exact V11 bypass: a real payment, the payer named, no proof. Nothing unlocks.
  assert.deepEqual(await verifyClaims(conn, [{ id: skillId, signature: SIG, buyer: payer.walletAddress }], USDC), []);
  // A replayer with their OWN valid wallet proof still fails: the on-chain tx did not debit
  // them, and the cached entry for the real payer never leaks to a different buyer.
  const replayer = makeProofBundle(skillId);
  assert.deepEqual(
    await verifyClaims(conn, [{ id: skillId, signature: SIG, buyer: replayer.walletAddress, proof: replayer.proof }], USDC),
    [],
  );
});

test("a self-built purchase that pays the platform only dust licenses nothing (F14 MEDIUM)", () => {
  const skill = PAID_SKILLS["usdc-price-watcher"]!;
  const buyer = base58Encode(makeKey().raw);
  // Author gets exactly the discounted minimum, platform gets a single base unit of dust.
  const dust = synthTx(buyer, { [skill.authorWallet]: minAuthorBaseUnits(skill), [PLATFORM_WALLET]: 1n }, skill.priceBaseUnits, USDC);
  assert.equal(isValidLicense(dust, skill, USDC, buyer), false);
  // The honest full-fee purchase still licenses.
  assert.equal(isValidLicense(synthLicenseTx(buyer, skill, USDC), skill, USDC, buyer), true);
  // The floor is the platform's share at the maximum SKR discount, less the rounding slack.
  assert.equal(minPlatformBaseUnits(skill), 74_996n);
});

test("skill challenges verify only inside their window and reject tampering", () => {
  const now = Date.now();
  const c = issueSkillChallenge(now);
  assert.equal(verifySkillChallenge(c, now + 1000), true);
  assert.equal(verifySkillChallenge(c, now + 10 * 60 * 1000), false); // expired
  const [exp, mac] = c.split(".");
  const flipped = mac!.slice(0, -1) + (mac!.endsWith("0") ? "1" : "0");
  assert.equal(verifySkillChallenge(`${exp}.${flipped}`, now + 1000), false); // tampered MAC
  assert.equal(verifySkillChallenge("not-a-challenge", now), false);
});

test("base58Encode matches the Solana address encoding", () => {
  assert.equal(base58Encode(new PublicKey(BUYER).toBytes()), BUYER);
  assert.equal(base58Encode(new PublicKey(PLATFORM_WALLET).toBytes()), PLATFORM_WALLET);
});

test("the same payment does not license a different or pricier skill", () => {
  assert.equal(isValidLicense(purchase, PAID_SKILLS["wallet-summarizer"]!, USDC, BUYER), false);
  assert.equal(isValidLicense(purchase, PAID_SKILLS["tx-explainer"]!, USDC, BUYER), false);
});

test("a failed, missing or wrong-mint transaction licenses nothing", () => {
  const skill = PAID_SKILLS["usdc-price-watcher"]!;
  const failed = { ...purchase, meta: { ...purchase.meta!, err: { InstructionError: [0, "Custom"] } } };
  assert.equal(isValidLicense(failed as ParsedTransactionWithMeta, skill, USDC, BUYER), false);
  assert.equal(isValidLicense(null, skill, USDC, BUYER), false);
  assert.equal(isValidLicense(purchase, skill, "So11111111111111111111111111111111111111112", BUYER), false);
});

test("the minimum honours the maximum creator SKR discount", () => {
  // 0.50 USDC price, 80% creator cut = 0.40, less up to 25% SKR discount = 0.30.
  assert.equal(minAuthorBaseUnits(PAID_SKILLS["usdc-price-watcher"]!), 300_000n);
});

test("parseClaims keeps only well-formed claims for known skills, deduped and capped", () => {
  const claims = parseClaims([
    { id: "usdc-price-watcher", signature: SIG, buyer: BUYER },
    { id: "usdc-price-watcher", signature: SIG, buyer: BUYER },
    { id: "not-a-skill", signature: SIG, buyer: BUYER },
    { id: "translator", signature: "short", buyer: BUYER },
    { id: "usdc-price-watcher", signature: SIG }, // no buyer, dropped (F14 HIGH)
    { id: "usdc-price-watcher", signature: SIG, buyer: "not a base58 address" }, // bad buyer, dropped
    { id: 7, signature: SIG, buyer: BUYER },
    "junk",
  ]);
  assert.deepEqual(claims, [{ id: "usdc-price-watcher", signature: SIG, buyer: BUYER }]);
  assert.deepEqual(parseClaims("nope"), []);
  // A well-shaped proof is carried through for later verification.
  const withProof = parseClaims([
    {
      id: "translator",
      signature: SIG,
      buyer: BUYER,
      proof: {
        challenge: "c",
        did: "did:key:zX",
        didSig: "s",
        binding: {
          did: "did:key:zX",
          walletAddress: BUYER,
          nonce: "n",
          context: "bond:wallet-did-binding:v1",
          version: 1,
          issuedAt: "t",
          expiresAt: "t",
          walletSignature: "w",
          didSignature: "d",
        },
      },
    },
  ]);
  assert.equal(withProof[0]?.proof?.binding.walletAddress, BUYER);
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
