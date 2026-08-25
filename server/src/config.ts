import dotenv from "dotenv";

// The lane .env must win over any stale value already in the process
// environment, so load with override on.
dotenv.config({ override: true });

function required(name: string, fallback: string): string {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

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
};

export type Config = typeof config;
