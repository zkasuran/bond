import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { config, bearerMatches, assertStartupConfig } from "./config.js";
import { gatewayRoutes } from "./gateway.js";
import { agentRoutes } from "./agent/route.js";
import { mountSync } from "./sync.js";
import { buildCsp, hashesForDist } from "./csp.js";
import { androidAssetLinks } from "./assetlinks.js";
import {
  HTTP_RATE_BURST,
  HTTP_RATE_PER_SEC,
  MAX_RATE_LIMIT_KEYS,
  KeyedRateLimiter,
} from "./limits.js";

// A runtime fault anywhere must be logged, never allowed to take the whole
// process down. Startup failures still exit through main().catch below.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err instanceof Error ? err.stack ?? err.message : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason instanceof Error ? reason.stack ?? reason.message : reason);
});

function bearerFrom(header?: string): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

// Static security headers for the hosted web build. The CSP is strict: scripts
// run only from 'self' plus the sha256 of each inline script the web export
// emitted (Expo Router inlines one hydrate flag), never 'unsafe-inline'. The
// hashes are read from the build at startup so they cannot drift from it.
let CSP = buildCsp([]);

function setStaticHeaders(reply: FastifyReply): void {
  reply.header("Content-Security-Policy", CSP);
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  reply.header(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  );
}

// The exported web build lives beside this service in ../app/dist. Resolve it
// from this module so the path holds wherever the repo is checked out.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../app/dist");

// Per-IP request limiter for the /v1 surface.
const httpLimiter = new KeyedRateLimiter(HTTP_RATE_BURST, HTTP_RATE_PER_SEC, MAX_RATE_LIMIT_KEYS);

async function main(): Promise<void> {
  // Refuse to start on a configuration that must not reach a running server.
  assertStartupConfig();

  const app = Fastify({
    logger: true,
    // Chat context can be large, so lift the body limit well above the 1 MB
    // default.
    bodyLimit: 16 * 1024 * 1024,
  });

  // Rate limit the /v1 surface before anything else runs, so an unauthenticated
  // flood is turned away cheaply.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    if (!httpLimiter.allow(request.ip)) {
      return reply.code(429).send({ error: "rate limit exceeded" });
    }
  });

  // Bearer auth on every /v1 route. Missing or wrong token is rejected before
  // the handler runs. The compare is constant time.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const token = bearerFrom(request.headers.authorization);
    if (!bearerMatches(token, config.bondBearer)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  // Digital Asset Links: proves this origin (the app's Mobile Wallet Adapter identity
  // URI) belongs to the Android app signed with the release key, so a wallet can
  // verify the dApp instead of warning "verification failed". Public data only.
  const assetLinks = androidAssetLinks(process.env.ANDROID_PACKAGE, process.env.ANDROID_CERT_SHA256);
  if (assetLinks) {
    // Serialized by hand: Solana Mobile's verifier requires the Content-Type to be exactly
    // "application/json" and rejects the "; charset=utf-8" Fastify would append.
    const body = JSON.stringify(assetLinks);
    app.get("/.well-known/assetlinks.json", async (_req, reply) => {
      reply.raw.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      reply.raw.end(body);
      return reply.hijack();
    });
  }

  await app.register(gatewayRoutes);
  await app.register(agentRoutes);

  // Serve the web build as the same origin when it has been exported. Without
  // it the API still runs, the site just is not hosted here yet. Security
  // headers are set on these static responses only, so /v1 and the SSE route
  // are left untouched.
  if (existsSync(webDist)) {
    CSP = buildCsp(hashesForDist(webDist));
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      setHeaders: setStaticHeaders,
    });
    app.log.info(`serving web build from ${webDist}`);
  } else {
    app.log.warn(`web build not found at ${webDist}, skipping static host`);
  }

  // The sync WebSocket server shares the same HTTP server.
  mountSync(app.server);

  // HOST=127.0.0.1 keeps the port private behind a TLS reverse proxy.
  await app.listen({ port: config.port, host: process.env.HOST || "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
