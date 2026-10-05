import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadWallet, solanaTools } from "./tools.js";
import { MAX_AGENT_TRANSFER_USDC } from "../limits.js";

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
