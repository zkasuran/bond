import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { config } from "./config.js";
import { base58Encode } from "./agent/skills.js";
import { setServerSecretForTest } from "./secret.js";
import {
  SESSION_CHALLENGE_TTL_MS,
  SESSION_TTL_MS,
  authenticate,
  issueSession,
  issueSessionChallenge,
  sessionMessageBytes,
  verifySessionToken,
} from "./session.js";
import { buildApp } from "./index.js";

setServerSecretForTest("test-session-secret");

// A fresh device did:key with a signer, like the app's on-device identity.
function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"));
  const payload = new Uint8Array(34);
  payload[0] = 0xed;
  payload[1] = 0x01;
  payload.set(raw, 2);
  const did = "did:key:z" + base58Encode(payload);
  const sign = (msg: Uint8Array) => Buffer.from(nodeSign(null, Buffer.from(msg), privateKey)).toString("base64url");
  return { did, sign };
}

function proofFor(device: ReturnType<typeof makeDevice>, now = Date.now()) {
  const challenge = issueSessionChallenge(now);
  return { did: device.did, challenge, signature: device.sign(sessionMessageBytes(device.did, challenge)) };
}

test("a did:key that signs a fresh challenge gets a session bound to that did", () => {
  const device = makeDevice();
  const s = issueSession(proofFor(device));
  assert.ok(s);
  assert.equal(verifySessionToken(s.token), device.did);
  assert.deepEqual(authenticate(s.token), { kind: "device", did: device.did });
});

test("a signature by a different key is rejected", () => {
  const device = makeDevice();
  const other = makeDevice();
  const proof = proofFor(device);
  proof.signature = other.sign(sessionMessageBytes(device.did, proof.challenge));
  assert.equal(issueSession(proof), null);
});

test("a challenge the server did not issue, or one past its window, is rejected", () => {
  const device = makeDevice();
  const forged = `${Date.now() + 60_000}.${"0".repeat(64)}`;
  assert.equal(
    issueSession({ did: device.did, challenge: forged, signature: device.sign(sessionMessageBytes(device.did, forged)) }),
    null,
  );
  const old = Date.now() - SESSION_CHALLENGE_TTL_MS - 1000;
  assert.equal(issueSession(proofFor(device, old)), null);
});

test("malformed bodies never throw and never mint", () => {
  for (const body of [null, 1, "x", {}, { did: "did:web:x", challenge: "a.b", signature: "zz" }]) {
    assert.equal(issueSession(body), null);
  }
});

test("a session token with a tampered did, expiry or MAC is rejected", () => {
  const device = makeDevice();
  const s = issueSession(proofFor(device))!;
  const [p, did, exp, tag] = s.token.split(".");
  const other = makeDevice().did;
  assert.equal(verifySessionToken([p, other, exp, tag].join(".")), null);
  assert.equal(verifySessionToken([p, did, String(Number(exp) + 1000), tag].join(".")), null);
  assert.equal(verifySessionToken([p, did, exp, "0".repeat(tag.length)].join(".")), null);
});

test("a session token stops working after its TTL", () => {
  const device = makeDevice();
  const s = issueSession(proofFor(device))!;
  assert.equal(verifySessionToken(s.token, Date.now() + SESSION_TTL_MS + 1000), null);
});

test("rotating the server secret revokes every outstanding session", () => {
  const device = makeDevice();
  const s = issueSession(proofFor(device))!;
  setServerSecretForTest("rotated-secret");
  try {
    assert.equal(verifySessionToken(s.token), null);
  } finally {
    setServerSecretForTest("test-session-secret");
  }
});

test("the operator bearer still authenticates, and an empty one authenticates nobody", () => {
  const prev = config.bondBearer;
  try {
    config.bondBearer = "operator-token";
    assert.deepEqual(authenticate("operator-token"), { kind: "operator" });
    assert.equal(authenticate("wrong"), null);
    config.bondBearer = "";
    assert.equal(authenticate(""), null);
    assert.equal(authenticate(null), null);
  } finally {
    config.bondBearer = prev;
  }
});

test("over HTTP: no credential is 401, a minted device session reaches /v1", async () => {
  const prev = config.bondBearer;
  config.bondBearer = "operator-token";
  const app = await buildApp();
  try {
    const denied = await app.inject({ method: "GET", url: "/v1/agent/skill-challenge" });
    assert.equal(denied.statusCode, 401);

    const ch = await app.inject({ method: "GET", url: "/v1/session/challenge" });
    assert.equal(ch.statusCode, 200);
    const { challenge } = ch.json() as { challenge: string };
    const device = makeDevice();
    const minted = await app.inject({
      method: "POST",
      url: "/v1/session",
      payload: { did: device.did, challenge, signature: device.sign(sessionMessageBytes(device.did, challenge)) },
    });
    assert.equal(minted.statusCode, 200);
    const { token } = minted.json() as { token: string };

    const ok = await app.inject({
      method: "GET",
      url: "/v1/agent/skill-challenge",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(ok.statusCode, 200);

    const bad = await app.inject({ method: "POST", url: "/v1/session", payload: { did: device.did, challenge, signature: "AA" } });
    assert.equal(bad.statusCode, 401);
  } finally {
    await app.close();
    config.bondBearer = prev;
  }
});
