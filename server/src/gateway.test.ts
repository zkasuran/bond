import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { gatewayRoutes } from "./gateway.js";
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
