import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadWallet, solanaTools, withTimeout, isSafeMcpUrl, sanitizeMcpTool } from "./tools.js";
import { MAX_AGENT_TRANSFER_USDC, MAX_AGENT_TRANSFER_TOTAL_USDC } from "../limits.js";

const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function tool(tools: Record<string, unknown>, name: string): { execute: (a: unknown) => Promise<unknown> } {
  return tools[name] as { execute: (a: unknown) => Promise<unknown> };
}

test("loadWallet derives a deterministic keypair from a JSON byte-array secret", () => {
  const kp = Keypair.generate();
  const w = loadWallet(JSON.stringify(Array.from(kp.secretKey)));
  assert.equal(w.ephemeral, false);
  assert.equal(w.keypair.publicKey.toBase58(), kp.publicKey.toBase58());
});

test("loadWallet generates an ephemeral keypair when no secret is set", () => {
  const w = loadWallet("");
  assert.equal(w.ephemeral, true);
  assert.ok(w.keypair.publicKey.toBase58().length >= 32);
});

test("solanaTools exposes the four named tools, each with an execute", () => {
  const tools = solanaTools(new Connection("https://api.devnet.solana.com"), Keypair.generate(), new PublicKey(DEVNET_USDC));
  assert.deepEqual(
    Object.keys(tools).sort(),
    ["solana_get_balance", "solana_price", "solana_swap_quote", "solana_transfer_usdc"],
  );
  for (const t of Object.values(tools)) {
    assert.equal(typeof (t as { execute?: unknown }).execute, "function");
  }
});

test("solana_price normalises a Jupiter response through a stubbed fetch", async () => {
  const mint = "So11111111111111111111111111111111111111112";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ [mint]: { usdPrice: 114.04, decimals: 9 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const tools = solanaTools(new Connection("https://api.devnet.solana.com"), Keypair.generate(), new PublicKey(DEVNET_USDC));
    const out = (await tool(tools, "solana_price").execute({ mint })) as {
      ok: boolean;
      usdPrice: number;
      decimals: number;
    };
    assert.equal(out.ok, true);
    assert.equal(out.usdPrice, 114.04);
    assert.equal(out.decimals, 9);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("solana_transfer_usdc returns a structured error rather than throwing on a bad address", async () => {
  const tools = solanaTools(new Connection("https://api.devnet.solana.com"), Keypair.generate(), new PublicKey(DEVNET_USDC));
  const out = (await tool(tools, "solana_transfer_usdc").execute({ to: "not-a-valid-address", amount: 1 })) as {
    ok: boolean;
    error?: string;
  };
  assert.equal(out.ok, false);
  assert.ok(typeof out.error === "string" && out.error.length > 0);
});

test("solana_transfer_usdc rejects an amount over the per-transfer cap before building a transfer", async () => {
  const recipient = Keypair.generate().publicKey.toBase58();
  const tools = solanaTools(new Connection("https://api.devnet.solana.com"), Keypair.generate(), new PublicKey(DEVNET_USDC));
  const over = MAX_AGENT_TRANSFER_USDC + 1;
  const out = (await tool(tools, "solana_transfer_usdc").execute({ to: recipient, amount: over })) as {
    ok: boolean;
    error?: string;
  };
  assert.equal(out.ok, false);
  assert.ok(out.error?.includes("per-transfer cap"), "the error names the cap it hit");
});

test("solana_transfer_usdc rejects a non-positive amount", async () => {
  const recipient = Keypair.generate().publicKey.toBase58();
  const tools = solanaTools(new Connection("https://api.devnet.solana.com"), Keypair.generate(), new PublicKey(DEVNET_USDC));
  const out = (await tool(tools, "solana_transfer_usdc").execute({ to: recipient, amount: 0 })) as {
    ok: boolean;
    error?: string;
  };
  assert.equal(out.ok, false);
  assert.ok(out.error?.includes("positive"));
});

test("concurrent transfers cannot drain past the per-process ceiling", async () => {
  // A fake connection so the transfer path never touches the network. getAccount
  // sees a null account (so the create-ATA branch runs), and the send resolves
  // after a microtask to make the concurrent interleave real.
  let sent = 0;
  const fakeConnection = {
    getAccountInfo: async () => null,
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
    sendTransaction: async () => {
      await new Promise((r) => setImmediate(r));
      sent += 1;
      return `sig${sent}`;
    },
  } as unknown as Connection;
  const recipient = Keypair.generate().publicKey.toBase58();
  const tools = solanaTools(fakeConnection, Keypair.generate(), new PublicKey(DEVNET_USDC));
  const transfer = tool(tools, "solana_transfer_usdc");
  // Fire many concurrent transfers, each at the per-transfer cap. Only
  // floor(total / per-transfer) can fit under the per-process ceiling.
  const n = 12;
  const results = (await Promise.all(
    Array.from({ length: n }, () => transfer.execute({ to: recipient, amount: MAX_AGENT_TRANSFER_USDC })),
  )) as Array<{ ok: boolean; amount?: number }>;
  const moved = results.filter((r) => r.ok).reduce((s, r) => s + (r.amount ?? 0), 0);
  assert.ok(
    moved <= MAX_AGENT_TRANSFER_TOTAL_USDC,
    `moved ${moved} USDC must not exceed the ${MAX_AGENT_TRANSFER_TOTAL_USDC} ceiling`,
  );
  assert.ok(
    results.some((r) => !r.ok),
    "at least one concurrent transfer is refused by the ceiling",
  );
});

test("withTimeout rejects a promise that never settles", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 30, "it timed out"), /it timed out/);
});

test("withTimeout resolves a promise that settles in time", async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, "unused"), 42);
});

test("isSafeMcpUrl rejects non-https, loopback, link-local and private targets", () => {
  assert.equal(isSafeMcpUrl("https://skills.example.com/mcp"), true);
  assert.equal(isSafeMcpUrl("http://skills.example.com/mcp"), false);
  assert.equal(isSafeMcpUrl("https://localhost/mcp"), false);
  assert.equal(isSafeMcpUrl("https://127.0.0.1/mcp"), false);
  assert.equal(isSafeMcpUrl("https://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isSafeMcpUrl("https://10.0.0.5/mcp"), false);
  assert.equal(isSafeMcpUrl("https://172.16.0.9/mcp"), false);
  assert.equal(isSafeMcpUrl("https://192.168.1.1/mcp"), false);
  assert.equal(isSafeMcpUrl("https://[::1]/mcp"), false);
  // IPv4-mapped IPv6 must not smuggle an internal IPv4 past the dotted-quad check (V9).
  assert.equal(isSafeMcpUrl("https://[::ffff:169.254.169.254]/latest/meta-data/"), false);
  assert.equal(isSafeMcpUrl("https://[::ffff:a9fe:a9fe]/mcp"), false);
  assert.equal(isSafeMcpUrl("https://[fe80::1]/mcp"), false);
  assert.equal(isSafeMcpUrl("https://[fd00::1]/mcp"), false);
  assert.equal(isSafeMcpUrl("not a url"), false);
});

test("sanitizeMcpTool rejects an unsafe or oversized tool name", () => {
  assert.equal(sanitizeMcpTool({ name: "../../evil tool", description: "x" }), null);
  assert.equal(sanitizeMcpTool({ name: "", description: "x" }), null);
  assert.equal(sanitizeMcpTool({ name: "a".repeat(200), description: "x" }), null);
  assert.ok(sanitizeMcpTool({ name: "good_tool", description: "fine" }));
});

test("sanitizeMcpTool bounds the description and strips control characters", () => {
  const ctrl = String.fromCharCode(0, 7, 27, 31, 127);
  const inject = `before${ctrl}after` + "y".repeat(5000);
  const safe = sanitizeMcpTool({ name: "good_tool", description: inject });
  assert.ok(safe);
  const hasControl = [...safe!.description].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  assert.equal(hasControl, false, "control chars are stripped");
  assert.ok(safe!.description.length <= 1024, "description is length bounded");
});

test("sanitizeMcpTool falls back to an empty schema for an oversized schema", () => {
  const big: { type: string; properties: Record<string, unknown> } = { type: "object", properties: {} };
  for (let i = 0; i < 5000; i++) big.properties[`k${i}`] = { type: "string", description: "z".repeat(50) };
  const safe = sanitizeMcpTool({ name: "good_tool", inputSchema: big });
  assert.ok(safe);
  assert.deepEqual(safe!.inputSchema, { type: "object", properties: {} });
});
