import test from "node:test";
import assert from "node:assert/strict";
import {
  config,
  bearerMatches,
  assertStartupConfig,
  resolveHost,
  resolveTrustProxy,
} from "./config.js";
import { buildApp, onFatal } from "./index.js";

// --- F22 MED: the bearer defences, previously claimed tested but unexercised --

test("bearerMatches is true only for the exact token and denies empty, null and wrong", () => {
  assert.equal(bearerMatches("secret", "secret"), true);
  assert.equal(bearerMatches("nope", "secret"), false);
  assert.equal(bearerMatches(null, "secret"), false);
  // An empty configured token denies every client (the empty default is deny-all).
  assert.equal(bearerMatches("anything", ""), false);
  assert.equal(bearerMatches("", ""), false);
  // Unequal input lengths must not throw: both sides are hashed to a fixed 32-byte
  // digest first, so timingSafeEqual always compares equal-length buffers.
  assert.equal(bearerMatches("a", "a-much-longer-configured-token"), false);
});

test("assertStartupConfig refuses to start on the change-me placeholder", () => {
  const prev = config.bondBearer;
  try {
    config.bondBearer = "change-me";
    assert.throws(() => assertStartupConfig(), /change-me/);
    config.bondBearer = "a-real-token";
    assert.doesNotThrow(() => assertStartupConfig());
  } finally {
    config.bondBearer = prev;
  }
});

// --- F22 LOW: private bind host plus no blind trust of X-Forwarded-For ------

test("resolveHost binds 127.0.0.1 unless HOST is set", () => {
  assert.equal(resolveHost(undefined), "127.0.0.1");
  assert.equal(resolveHost(""), "127.0.0.1");
  assert.equal(resolveHost("   "), "127.0.0.1");
  assert.equal(resolveHost("0.0.0.0"), "0.0.0.0");
});

test("resolveTrustProxy does not trust forwarded headers unless TRUST_PROXY is set", () => {
  assert.equal(resolveTrustProxy(undefined), false);
  assert.equal(resolveTrustProxy(""), false);
  assert.equal(resolveTrustProxy("false"), false);
  assert.equal(resolveTrustProxy("0"), false);
  assert.equal(resolveTrustProxy("true"), true);
  assert.equal(resolveTrustProxy("1"), true);
  assert.equal(resolveTrustProxy("127.0.0.1,10.0.0.0/8"), "127.0.0.1,10.0.0.0/8");
});

// --- F22 LOW: fatal faults fail loud rather than being swallowed ------------

test("onFatal logs and exits non-zero rather than swallowing the fault", () => {
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  };
  let code = -1;
  try {
    onFatal("uncaughtException", new Error("boom"), (c) => {
      code = c;
    });
  } finally {
    console.error = origErr;
  }
  assert.equal(code, 1);
  assert.ok(errs.some((e) => e.includes("uncaughtException")));
});

// --- F22 MED: auth and rate limit tied to the protected route registration --

test("the protected scope requires a bearer while /health stays open", async () => {
  const prevBearer = config.bondBearer;
  config.bondBearer = "cfg-scope-token";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const app = await buildApp();
  try {
    const noAuth = await app.inject({ method: "GET", url: "/v1/models" });
    assert.equal(noAuth.statusCode, 401, "a /v1 route with no bearer is unauthorized");

    const authed = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer cfg-scope-token" },
    });
    assert.equal(authed.statusCode, 200, "a valid bearer reaches the handler");

    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200, "health needs no bearer");

    // The guard is tied to route registration, not a raw-URL prefix, so an encoded
    // separator cannot reach a protected handler without the auth hook running.
    const encoded = await app.inject({ method: "GET", url: "/v1%2Fmodels" });
    assert.ok(
      encoded.statusCode === 404 || encoded.statusCode === 401,
      `encoded path must not be served unauthenticated, got ${encoded.statusCode}`,
    );
    assert.notEqual(encoded.statusCode, 200);
  } finally {
    globalThis.fetch = realFetch;
    config.bondBearer = prevBearer;
    await app.close();
  }
});

// --- F22 regression: assetlinks content-type stays exactly application/json -

test("assetlinks is served with content-type exactly application/json", async () => {
  const prevPkg = process.env.ANDROID_PACKAGE;
  const prevCert = process.env.ANDROID_CERT_SHA256;
  process.env.ANDROID_PACKAGE = "com.zkasuran.bond";
  process.env.ANDROID_CERT_SHA256 =
    "BB:4F:34:37:FD:B2:FF:35:07:CB:84:3C:4C:45:B6:90:FE:EE:5B:18:0C:99:E5:B2:E0:9F:88:FA:14:55:22:C1";
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/.well-known/assetlinks.json" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/json");
    const parsed = JSON.parse(res.body) as Array<{ target: { package_name: string } }>;
    assert.equal(parsed[0]!.target.package_name, "com.zkasuran.bond");
  } finally {
    if (prevPkg === undefined) delete process.env.ANDROID_PACKAGE;
    else process.env.ANDROID_PACKAGE = prevPkg;
    if (prevCert === undefined) delete process.env.ANDROID_CERT_SHA256;
    else process.env.ANDROID_CERT_SHA256 = prevCert;
    await app.close();
  }
});
