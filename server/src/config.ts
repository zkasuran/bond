import { createHash, timingSafeEqual } from "node:crypto";
import dotenv from "dotenv";

// The lane .env must win over any stale value already in the process
// environment, so load with override on.
dotenv.config({ override: true });

function required(name: string, fallback: string): string {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

// The host the server binds to. Default 127.0.0.1 keeps the plaintext port
// private behind a TLS reverse proxy; an operator opens it on every interface
// deliberately with HOST=0.0.0.0, never by forgetting to set it.
export function resolveHost(raw: string | undefined): string {
  return raw != null && raw.trim() !== "" ? raw : "127.0.0.1";
}

// Whether to trust an X-Forwarded-For header for the client IP. Off unless
// TRUST_PROXY is set, because XFF is client-spoofable: trusting it blindly lets
// any caller forge its rate-limit identity. "true"/"1" trust it, "false"/"0" do
// not, anything else is passed to Fastify as a proxy address or CIDR list.
export function resolveTrustProxy(raw: string | undefined): boolean | string {
  if (raw == null) return false;
  const v = raw.trim();
  if (v === "") return false;
  const low = v.toLowerCase();
  if (low === "true" || v === "1") return true;
  if (low === "false" || v === "0") return false;
  return v;
}

// Devnet USDC mint. This is the token the payment tools move on devnet.
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const config = {
  // Port the HTTP + WebSocket server binds to.
  port: Number(process.env.PORT ?? 8080),

  // Shared device token. Every /v1 and /sync client presents this as a
  // Bearer token. Empty means no client can authenticate, which is a safe
  // default until it is set in .env.
  bondBearer: process.env.BOND_BEARER ?? "",

  // Upstream OpenAI-compatible endpoint. These are neutral defaults and the
  // real host, key and model for this workspace live in .env.
  openaiBaseUrl: required("OPENAI_BASE_URL", "https://api.openai.com/v1"),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: required("OPENAI_MODEL", "gpt-4o-mini"),

  // Agent runtime. The provider is chosen at request time, defaulting to this.
  // "openai" reuses the OpenAI-compatible endpoint above, so the built-in
  // agent works with no extra setup. "anthropic" needs ANTHROPIC_API_KEY.
  aiProvider: required("AI_PROVIDER", "openai").toLowerCase(),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",

  // Optional model override for the agent loop. Empty falls back to a
  // provider default (openai -> OPENAI_MODEL, anthropic -> a Claude default).
  agentModel: process.env.AGENT_MODEL ?? "",

  // Ceiling on tool-calling steps in one turn. The loop stops when it reaches
  // this many steps even if the model would keep going.
  agentMaxSteps: Number(process.env.AGENT_MAX_STEPS ?? 8),

  // The agent self-custodies a server-held keypair, because a mobile wallet
  // (MWA / Seed Vault) always prompts and cannot sign unattended. Accepts a
  // base58 secret key or a JSON array of bytes. Empty means an ephemeral
  // keypair is generated per process (fine for read-only demos, cannot hold
  // funds across restarts).
  agentSolanaSecret: process.env.AGENT_SOLANA_SECRET ?? "",

  // Solana RPC. Devnet by default so the payment tools never touch mainnet
  // funds.
  solanaRpcUrl: required("SOLANA_RPC_URL", "https://api.devnet.solana.com"),

  // The USDC mint the balance and transfer tools use on devnet.
  usdcMint: required("USDC_MINT", DEVNET_USDC),

  // Optional MCP skill server. When set, its tools are imported over
  // StreamableHTTP and exposed to the agent under the mcp_ namespace.
  mcpSkillUrl: process.env.MCP_SKILL_URL ?? "",

  // Browser Origins allowed to open a sync WebSocket, comma-separated in
  // ALLOWED_ORIGINS. A same-origin request (the bundled web build) is always
  // allowed, so this list only names extra cross-origin front ends.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),

  // Host the HTTP + WebSocket server binds to. Private by default.
  host: resolveHost(process.env.HOST),

  // Trust an X-Forwarded-For header for the client IP only when TRUST_PROXY is
  // set. Passed straight to Fastify, so request.ip is the socket peer by default
  // and the real client behind a configured proxy, never a spoofable header.
  trustProxy: resolveTrustProxy(process.env.TRUST_PROXY),

  // Allow a sync WebSocket upgrade that carries no Origin header. Off by default
  // (fail closed). A native-client deployment that needs headerless clients sets
  // SYNC_ALLOW_MISSING_ORIGIN=1 deliberately.
  syncAllowMissingOrigin: process.env.SYNC_ALLOW_MISSING_ORIGIN === "1",
};

export type Config = typeof config;

// Constant-time bearer compare. Both sides are hashed to a fixed 32-byte digest
// first, so the comparison never leaks the token length through timing and
// timingSafeEqual always receives equal-length buffers. An empty configured
// token denies every client, which keeps the empty default a deny-all.
export function bearerMatches(presented: string | null, expected: string): boolean {
  if (!expected || presented == null) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Fail fast at startup on a configuration that must not reach a running server.
// Called from index.ts main() rather than at import, so a test that imports
// config does not trip it.
export function assertStartupConfig(): void {
  if (config.bondBearer === "change-me") {
    throw new Error(
      "BOND_BEARER is still the change-me placeholder. Set a real token in .env before starting the server.",
    );
  }
}
