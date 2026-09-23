// Agent tools. Two families are exposed to the loop:
//
//   solana_*   real Solana actions built on @solana/web3.js and @solana/spl-token,
//              signing with a server-held keypair on devnet, plus a Jupiter quote.
//   mcp_*      tools imported from an external MCP skill server, when one is set.
//   agentkit_* whatever solana-agent-kit v2 exposes through createVercelAITools.
//
// Why the solana_* tools are built directly rather than taken from
// createVercelAITools: solana-agent-kit v2 pins the Vercel AI SDK at v4 and its
// core ships zero actions until a plugin is added, so createVercelAITools returns
// an empty set here and its tool shape (parameters) is not the shape this loop's
// AI SDK reads (inputSchema). We still call it and re-wrap anything it returns, so
// installing an agent-kit plugin later lights up automatically, but the four named
// payment and market tools are first-class here so they always work.
import { tool, jsonSchema, type ToolSet } from "ai";
import { z } from "zod";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../config.js";
import { errText } from "./events.js";

const USDC_DECIMALS = 6;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Minimal base58 decode so the keypair loader takes a Phantom-style secret with
// no extra dependency.
function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const ch of str) {
    const idx = B58.indexOf(ch);
    if (idx === -1) throw new Error("invalid base58 in AGENT_SOLANA_SECRET");
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (let i = 0; i < str.length && str[i] === "1"; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

export interface AgentWallet {
  keypair: Keypair;
  ephemeral: boolean;
}

// Load the server keypair from config. Generate an ephemeral one when no secret
// is set. Never logs or returns the secret, only the public key travels outward.
export function loadWallet(secret: string): AgentWallet {
  const s = secret.trim();
  if (!s) return { keypair: Keypair.generate(), ephemeral: true };
  const bytes = s.startsWith("[")
    ? Uint8Array.from(JSON.parse(s) as number[])
    : base58Decode(s);
  return { keypair: Keypair.fromSecretKey(bytes), ephemeral: false };
}

export interface BuiltTools {
  tools: ToolSet;
  cleanup: () => Promise<void>;
  info: {
    walletPublicKey: string;
    ephemeralWallet: boolean;
    solanaToolCount: number;
    mcpToolCount: number;
    agentkitToolCount: number;
    agentKitEnabled: boolean;
    mcpConnected: boolean;
  };
}

const JUPITER = "https://lite-api.jup.ag";

// The four first-class Solana tools. All read/write happens against the RPC in
// config (devnet by default). The swap tool is the one exception: Jupiter is
// mainnet only, so it returns a live quote and an unsigned transaction and never
// signs or submits.
export function solanaTools(connection: Connection, wallet: Keypair, usdcMint: PublicKey): ToolSet {
  return {
    solana_get_balance: tool({
      description:
        "Get the SOL and devnet USDC balance of a Solana address. Defaults to the agent's own wallet when no address is given.",
      inputSchema: z.object({
        address: z
          .string()
          .optional()
          .describe("base58 address to check; defaults to the agent wallet"),
      }),
      execute: async ({ address }) => {
        const owner = address ? new PublicKey(address) : wallet.publicKey;
        const lamports = await connection.getBalance(owner);
        let usdc = 0;
        try {
          const ata = await getAssociatedTokenAddress(usdcMint, owner);
          const acc = await getAccount(connection, ata);
          usdc = Number(acc.amount) / 10 ** USDC_DECIMALS;
        } catch {
          usdc = 0;
        }
        return {
          address: owner.toBase58(),
          sol: lamports / LAMPORTS_PER_SOL,
          usdc,
          usdcMint: usdcMint.toBase58(),
          cluster: "devnet",
        };
      },
    }),

    solana_transfer_usdc: tool({
      description:
        "Send devnet USDC from the agent wallet to a recipient. Signs and submits on devnet, creating the recipient token account when needed. Returns the transaction signature.",
      inputSchema: z.object({
        to: z.string().describe("recipient base58 address"),
        amount: z.number().positive().describe("amount of USDC to send, in whole USDC"),
      }),
      execute: async ({ to, amount }) => {
        try {
          const dest = new PublicKey(to);
          const raw = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
          const fromAta = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);
          const toAta = await getAssociatedTokenAddress(usdcMint, dest);
          const ixs = [];
          try {
            await getAccount(connection, toAta);
          } catch {
            ixs.push(
              createAssociatedTokenAccountInstruction(wallet.publicKey, toAta, dest, usdcMint),
            );
          }
          ixs.push(
            createTransferCheckedInstruction(
              fromAta,
              usdcMint,
              toAta,
              wallet.publicKey,
              raw,
              USDC_DECIMALS,
            ),
          );
          const tx = new Transaction().add(...ixs);
          tx.feePayer = wallet.publicKey;
          tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
          const signature = await connection.sendTransaction(tx, [wallet]);
          return {
            ok: true,
            signature,
            explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
            amount,
            to: dest.toBase58(),
          };
        } catch (err) {
          return { ok: false, error: errText(err) };
        }
      },
    }),

    solana_price: tool({
      description: "Get the current USD price of a Solana token by mint address, from Jupiter.",
      inputSchema: z.object({
        mint: z.string().describe("token mint address"),
      }),
      execute: async ({ mint }) => {
        try {
          const res = await fetch(`${JUPITER}/price/v3?ids=${encodeURIComponent(mint)}`);
          if (!res.ok) return { ok: false, error: `Jupiter price HTTP ${res.status}` };
          const data = (await res.json()) as Record<string, { usdPrice?: number; decimals?: number }>;
          const row = data?.[mint];
          if (!row) return { ok: false, error: "no price found for that mint" };
          return { ok: true, mint, usdPrice: row.usdPrice, decimals: row.decimals };
        } catch (err) {
          return { ok: false, error: errText(err) };
        }
      },
    }),

    solana_swap_quote: tool({
      description:
        "Fetch a live Jupiter swap quote and build the unsigned swap transaction (mainnet). Returns the route and a base64 unsigned transaction. It does not sign or submit, on-chain swaps stay a human decision.",
      inputSchema: z.object({
        inputMint: z.string().describe("mint to swap from"),
        outputMint: z.string().describe("mint to swap to"),
        amount: z
          .number()
          .int()
          .positive()
          .describe("amount in the input token's base units (integer, not decimal)"),
        slippageBps: z.number().int().positive().optional().describe("slippage in basis points, default 50"),
      }),
      execute: async ({ inputMint, outputMint, amount, slippageBps }) => {
        try {
          const q = new URLSearchParams({
            inputMint,
            outputMint,
            amount: String(amount),
            slippageBps: String(slippageBps ?? 50),
          });
          const qres = await fetch(`${JUPITER}/swap/v1/quote?${q.toString()}`);
          if (!qres.ok) return { ok: false, error: `Jupiter quote HTTP ${qres.status}` };
          const quote = (await qres.json()) as Record<string, unknown>;
          const sres = await fetch(`${JUPITER}/swap/v1/swap`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              quoteResponse: quote,
              userPublicKey: wallet.publicKey.toBase58(),
              wrapAndUnwrapSol: true,
            }),
          });
          const swap = sres.ok ? ((await sres.json()) as Record<string, unknown>) : null;
          return {
            ok: true,
            inAmount: quote.inAmount,
            outAmount: quote.outAmount,
            priceImpactPct: quote.priceImpactPct,
            unsignedTransaction: swap ? swap.swapTransaction : null,
            note: "mainnet quote, transaction is unsigned. Signing and submitting is out of scope for the devnet agent.",
          };
        } catch (err) {
          return { ok: false, error: errText(err) };
        }
      },
    }),
  };
}

// Connect to an MCP skill server over StreamableHTTP and expose its tools under
// the mcp_ namespace. Returns a close function that tears the connection down.
async function mcpTools(url: string): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const client = new Client({ name: "bond-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  const listed = await client.listTools();
  const tools: ToolSet = {};
  for (const t of listed.tools) {
    tools[`mcp_${t.name}`] = tool({
      description: t.description ?? `MCP skill: ${t.name}`,
      inputSchema: jsonSchema((t.inputSchema ?? { type: "object", properties: {} }) as object),
      execute: async (args) => {
        const result = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> });
        return result;
      },
    });
  }
  return { tools, close: () => client.close() };
}

// Re-wrap whatever solana-agent-kit v2 exposes through createVercelAITools into
// this AI SDK's tool shape. Empty until an agent-kit plugin is installed. Loaded
// dynamically and only on Node 22+, because SolanaAgentKit requires it, so an
// older runtime keeps the first-class solana_* tools instead of crashing.
async function agentKitTools(wallet: Keypair): Promise<ToolSet> {
  const out: ToolSet = {};
  try {
    const kit = (await import("solana-agent-kit")) as unknown as {
      SolanaAgentKit: new (w: unknown, rpc: string, cfg: object) => { actions: unknown[] };
      KeypairWallet: new (kp: Keypair, rpc: string) => unknown;
      createVercelAITools: (
        agent: unknown,
        actions: unknown[],
      ) => Record<
        string,
        {
          description?: string;
          parameters?: unknown;
          execute?: (args: unknown) => Promise<unknown>;
          id?: string;
        }
      >;
    };
    const kitWallet = new kit.KeypairWallet(wallet, config.solanaRpcUrl);
    const agent = new kit.SolanaAgentKit(kitWallet, config.solanaRpcUrl, {});
    const raw = kit.createVercelAITools(agent, agent.actions ?? []);
    for (const [key, t] of Object.entries(raw)) {
      if (!t || typeof t.execute !== "function" || !t.parameters) continue;
      const name = t.id ?? `action_${key}`;
      out[`agentkit_${name}`] = tool({
        description: t.description ?? name,
        inputSchema: t.parameters as never,
        execute: t.execute,
      });
    }
  } catch {
    // Agent-kit is optional. If it is not installed or fails to load, the
    // first-class solana_* tools still carry the loop.
  }
  return out;
}

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

// Assemble every tool the loop can call. One call per turn keeps the MCP
// connection fresh and scoped to the request.
export async function buildTools(): Promise<BuiltTools> {
  const { keypair, ephemeral } = loadWallet(config.agentSolanaSecret);
  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const usdcMint = new PublicKey(config.usdcMint);

  const solana = solanaTools(connection, keypair, usdcMint);

  const agentKitEnabled = nodeMajor() >= 22;
  const agentkit = agentKitEnabled ? await agentKitTools(keypair) : {};

  let mcp: ToolSet = {};
  let mcpClose: () => Promise<void> = async () => {};
  let mcpConnected = false;
  if (config.mcpSkillUrl) {
    try {
      const loaded = await mcpTools(config.mcpSkillUrl);
      mcp = loaded.tools;
      mcpClose = loaded.close;
      mcpConnected = true;
    } catch {
      // A skill server that is down must not take the turn down with it.
      mcp = {};
    }
  }

  const tools: ToolSet = { ...solana, ...agentkit, ...mcp };

  return {
    tools,
    cleanup: async () => {
      await mcpClose().catch(() => {});
    },
    info: {
      walletPublicKey: keypair.publicKey.toBase58(),
      ephemeralWallet: ephemeral,
      solanaToolCount: Object.keys(solana).length,
      mcpToolCount: Object.keys(mcp).length,
      agentkitToolCount: Object.keys(agentkit).length,
      agentKitEnabled,
      mcpConnected,
    },
  };
}
