// Agent tools. Two families are exposed to the loop:
//
//   solana_*   real Solana actions built on @solana/web3.js and @solana/spl-token,
//              signing with a server-held keypair on devnet, plus a Jupiter quote.
//   mcp_*      tools imported from an external MCP skill server, when one is set.
//
// The solana_* payment and market tools are hand-built on web3.js rather than
// taken from a kit: the four named tools are first-class here so they always
// work, with their spend caps enforced in code below.
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
import { MAX_AGENT_TRANSFER_USDC, MAX_AGENT_TRANSFER_TOTAL_USDC } from "../limits.js";
import { errText } from "./events.js";

const USDC_DECIMALS = 6;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// MCP import ceilings. limits.ts is owned by another engineer right now, so these
// live here as local named constants until they move there.
const MCP_IMPORT_TIMEOUT_MS = 10_000; // connect + listTools must finish inside this
const MCP_CALL_TIMEOUT_MS = 30_000; // a single imported tool call
const MAX_MCP_TOOLS = 32; // most tools imported from one skill server
const MAX_MCP_DESC = 1024; // longest imported tool description
const MAX_MCP_SCHEMA_BYTES = 16 * 1024; // longest serialized input schema

// Cumulative USDC moved by the transfer tool over the life of this process.
// Enforced in code against MAX_AGENT_TRANSFER_TOTAL_USDC so an agent cannot be
// talked into draining the wallet across many turns. The reserve-before-await
// pattern in solana_transfer_usdc keeps the check-and-reserve atomic, so N
// concurrent transfers cannot each read this at the same value and all pass.
let transferredThisProcess = 0;

// Resolve a promise or reject once ms has passed, clearing the timer either way.
// Used to bound an MCP connect, list or call so a stalled skill server cannot
// hang the whole turn server side.
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Only an https target that is not an internal, loopback or link-local address is
// a safe MCP import. This blocks the SSRF shapes (metadata IP, 127/8, RFC1918,
// 169.254/16, and every IPv6 literal) for literal hosts. A hostname that resolves
// to an internal address (DNS rebinding), or an https redirect from a public host
// to an internal one, is a documented residual, since the MCP URL is config/env
// only and is never taken from a client request.
export function isSafeMcpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "0.0.0.0") return false;
  // Reject every IPv6 literal. A legitimate MCP server is reached by hostname or
  // IPv4. IPv6 literals carry too many SSRF forms to enumerate safely: ::1 and ::
  // loopback, fe80 link-local, fc/fd unique-local, and IPv4-mapped forms like
  // ::ffff:169.254.169.254 that smuggle an internal IPv4 past a dotted-quad check.
  if (host.includes(":")) return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 169 && b === 254) return false; // link-local, incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false; // multicast and reserved
  }
  return true;
}

export interface RawMcpTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

// Clean one tool advertised by an MCP skill server before it is exposed to the
// model. A name that is not a bounded plain identifier is rejected outright, the
// description has control characters stripped and is length-bounded so it cannot
// be an unbounded prompt-injection payload, and an oversized or non-object input
// schema falls back to an empty object schema.
export function sanitizeMcpTool(
  raw: RawMcpTool,
): { name: string; description: string; inputSchema: object } | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) return null;
  let description = typeof raw.description === "string" ? raw.description : `MCP skill: ${name}`;
  description = description.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_MCP_DESC);
  let inputSchema: object = { type: "object", properties: {} };
  if (raw.inputSchema && typeof raw.inputSchema === "object") {
    try {
      if (JSON.stringify(raw.inputSchema).length <= MAX_MCP_SCHEMA_BYTES) {
        inputSchema = raw.inputSchema as object;
      }
    } catch {
      // Keep the empty schema when the advertised one will not serialize.
    }
  }
  return { name, description, inputSchema };
}

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
        // Hard spend caps, enforced in code before the transfer is built. A
        // prompt instruction can never raise or bypass these.
        if (!Number.isFinite(amount) || amount <= 0) {
          return { ok: false, error: "amount must be a positive number of USDC" };
        }
        if (amount > MAX_AGENT_TRANSFER_USDC) {
          return {
            ok: false,
            error: `transfer of ${amount} USDC exceeds the per-transfer cap of ${MAX_AGENT_TRANSFER_USDC} USDC`,
          };
        }
        // Atomic check-and-reserve against the running process total. The reserve
        // happens here, synchronously, before any await, so N concurrent transfers
        // cannot each read the total at the same value and all pass the check. A
        // transfer that fails to send rolls its reservation back.
        if (transferredThisProcess + amount > MAX_AGENT_TRANSFER_TOTAL_USDC) {
          return {
            ok: false,
            error: `transfer would exceed the per-process spend ceiling of ${MAX_AGENT_TRANSFER_TOTAL_USDC} USDC`,
          };
        }
        transferredThisProcess += amount;
        let reserved = true;
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
          // The transfer went out, so the reservation is now a real spend. Keep it.
          reserved = false;
          return {
            ok: true,
            signature,
            explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
            amount,
            to: dest.toBase58(),
          };
        } catch (err) {
          // The send never happened, so give the reserved amount back.
          if (reserved) transferredThisProcess -= amount;
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
  if (!isSafeMcpUrl(url)) throw new Error("MCP skill URL is not an allowed https target");
  const client = new Client({ name: "bond-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  // Bound the connect and list so a skill server that accepts the socket then
  // stalls cannot hang the turn server side after the client has gone.
  await withTimeout(client.connect(transport), MCP_IMPORT_TIMEOUT_MS, "MCP connect timed out");
  const listed = await withTimeout(client.listTools(), MCP_IMPORT_TIMEOUT_MS, "MCP listTools timed out");
  const tools: ToolSet = {};
  let count = 0;
  for (const t of listed.tools) {
    if (count >= MAX_MCP_TOOLS) break;
    // Sanitize the advertised name, description and schema before the model sees
    // any of them. A tool that will not sanitize is skipped, not trusted.
    const safe = sanitizeMcpTool(t as RawMcpTool);
    if (!safe) continue;
    count += 1;
    tools[`mcp_${safe.name}`] = tool({
      description: safe.description,
      inputSchema: jsonSchema(safe.inputSchema),
      execute: async (args) => {
        return withTimeout(
          client.callTool({ name: safe.name, arguments: args as Record<string, unknown> }),
          MCP_CALL_TIMEOUT_MS,
          "MCP tool call timed out",
        );
      },
    });
  }
  return { tools, close: () => client.close() };
}

// Assemble every tool the loop can call. One call per turn keeps the MCP
// connection fresh and scoped to the request.
export async function buildTools(): Promise<BuiltTools> {
  const { keypair, ephemeral } = loadWallet(config.agentSolanaSecret);
  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const usdcMint = new PublicKey(config.usdcMint);

  const solana = solanaTools(connection, keypair, usdcMint);

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

  const tools: ToolSet = { ...solana, ...mcp };

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
      mcpConnected,
    },
  };
}
