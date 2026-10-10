import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { gatewayRoutes, capStream, acquireSlot, MAX_CONCURRENT_UPSTREAM_PER_KEY } from "./gateway.js";
import { MAX_CONCURRENT_UPSTREAM } from "./limits.js";
import { config } from "./config.js";

// Build a Fastify app with only the gateway routes mounted. The bearer auth
// hook lives in index.ts, so injecting here isolates the proxy behaviour.
async function app() {
  const f = Fastify();
  await f.register(gatewayRoutes);
  return f;
}

test("the gateway never forwards the client Authorization upstream", async () => {
  const clientToken = "Bearer client-secret-should-not-leak";
  let captured: Record<string, string> | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const f = await app();
  try {
    const res = await f.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: clientToken, "content-type": "application/json" },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(captured, "upstream fetch should have been called");
    // The only credential sent upstream is the configured upstream key, never
    // the client's bearer.
    assert.equal(captured.authorization, `Bearer ${config.openaiApiKey}`);
    assert.notEqual(captured.authorization, clientToken);
    const values = Object.values(captured).join(" ");
    assert.ok(!values.includes("client-secret-should-not-leak"), "client token must not be forwarded");
  } finally {
    globalThis.fetch = realFetch;
    await f.close();
  }
});

test("an upstream error body is never relayed back to the client", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-REALKEY-LEAK-123" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const f = await app();
  try {
    const res = await f.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.statusCode, 401);
    assert.ok(!res.payload.includes("sk-REALKEY-LEAK-123"), "an echoed key must not reach the client");
    assert.ok(!res.payload.includes("Incorrect API key"), "the upstream error body is not relayed");
  } finally {
    globalThis.fetch = realFetch;
    await f.close();
  }
});

test("the gateway does not follow upstream redirects", async () => {
  let captured: RequestInit | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const f = await app();
  try {
    await f.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(captured?.redirect, "manual", "redirects are not followed");
  } finally {
    globalThis.fetch = realFetch;
    await f.close();
  }
});

test("one client cannot take more than its share when the proxy sets a trusted client id", () => {
  const saved = config.trustProxy;
  const releases: Array<() => void> = [];
  try {
    // A scoped TRUST_PROXY means request.ip is the real client the proxy wrote,
    // so the per-key cap gives genuine per-client isolation.
    config.trustProxy = "10.0.0.1";
    for (let i = 0; i < MAX_CONCURRENT_UPSTREAM_PER_KEY; i++) {
      const r = acquireSlot("1.2.3.4");
      assert.ok(r, `slot ${i} for the client is granted`);
      releases.push(r!);
    }
    // The next request from the same client is refused.
    assert.equal(acquireSlot("1.2.3.4"), null, "the client is held to its share");
    // A different client is still served.
    const other = acquireSlot("5.6.7.8");
    assert.ok(other, "a different client is not starved by the first");
    releases.push(other!);
    // Releasing one lets the first client acquire again.
    releases[0]!();
    const again = acquireSlot("1.2.3.4");
    assert.ok(again, "a freed slot is reusable");
    releases.push(again!);
  } finally {
    config.trustProxy = saved;
    for (const r of releases) r();
  }
});

test("the per-client cap does not collapse throughput when clients share a proxy IP", () => {
  const saved = config.trustProxy;
  const releases: Array<() => void> = [];
  try {
    // No trusted client identifier (the documented default behind a reverse
    // proxy): every client collapses to the one proxy socket IP. The per-key cap
    // of a handful must not throttle the whole fleet, so one shared key may reach
    // the global pool rather than stopping at MAX_CONCURRENT_UPSTREAM_PER_KEY.
    config.trustProxy = false;
    for (let i = 0; i < MAX_CONCURRENT_UPSTREAM; i++) {
      const r = acquireSlot("10.0.0.1"); // the one address every client shares
      assert.ok(r, `shared-proxy slot ${i} is granted up to the global pool`);
      releases.push(r!);
    }
    // The global pool is still the real ceiling, now reached by the shared key.
    assert.equal(acquireSlot("10.0.0.1"), null, "the global pool still bounds the shared key");
  } finally {
    config.trustProxy = saved;
    for (const r of releases) r();
  }
});

test("capStream cuts off an upstream body that stalls past the idle deadline", async () => {
  const web = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial "));
      // Then never enqueue again and never close: the body stalls.
    },
  });
  const out = capStream(web as never, 1024 * 1024, 60);
  const result = await new Promise<string>((resolve) => {
    out.on("data", () => {});
    out.on("error", (e: Error) => resolve(`error:${e.message}`));
    out.on("end", () => resolve("end"));
    setTimeout(() => resolve("hung"), 1500);
  });
  assert.match(result, /error:.*idle/, "a stalled body is torn down by the idle timeout");
});

test("capStream enforces an overall deadline even when the body trickles under the idle window", async () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  const web = new ReadableStream<Uint8Array>({
    start(controller) {
      // A chunk every 30ms keeps resetting a 100ms idle timer forever, so only
      // an absolute deadline can stop it. The stream never closes on its own.
      timer = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode("x"));
        } catch {
          if (timer) clearInterval(timer);
        }
      }, 30);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  const out = capStream(web as never, 1024 * 1024, 100, 200);
  try {
    const result = await new Promise<string>((resolve) => {
      out.on("data", () => {});
      out.on("error", (e: Error) => resolve(`error:${e.message}`));
      out.on("end", () => resolve("end"));
      setTimeout(() => resolve("hung"), 1200);
    });
    assert.match(result, /error:.*total/, "a trickling body is still cut by the overall deadline");
  } finally {
    if (timer) clearInterval(timer);
    out.destroy();
  }
});
