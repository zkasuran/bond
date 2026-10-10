import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
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

// Log a fatal fault, then exit non-zero. An uncaughtException or unhandledRejection
// leaves the process in an undefined state (half-written buffers, leaked sockets, a
// partially applied transfer), which Node documents as unsafe to resume. The server
// fails loud and a supervisor restarts it rather than serving corrupt state. The
// exit is injected so the behaviour is testable without killing the test process.
export function onFatal(label: string, err: unknown, exit: (code: number) => void): void {
  console.error(`${label}:`, err instanceof Error ? err.stack ?? err.message : err);
  exit(1);
}

// Registered only when the server runs as the entry point, so importing this
// module (for buildApp in a test) never installs process-exiting handlers.
function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => onFatal("uncaughtException", err, (c) => process.exit(c)));
  process.on("unhandledRejection", (reason) =>
    onFatal("unhandledRejection", reason, (c) => process.exit(c)),
  );
}

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

// Build the configured Fastify app without listening, so a test can drive it with
// inject and the process entry can listen on it.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    // Chat context can be large, so lift the body limit well above the 1 MB
    // default.
    bodyLimit: 16 * 1024 * 1024,
    // request.ip is the socket peer by default. Behind a configured proxy it
    // resolves to the real client from X-Forwarded-For, so the rate limiter keys
    // on the caller rather than collapsing to the proxy's single IP. Off unless
    // TRUST_PROXY is set, because the forwarded header is otherwise spoofable.
    trustProxy: config.trustProxy,
  });

  // The paid surface carries its own rate limit and bearer auth, scoped to the
  // plugin the protected routes are registered in. The guard is tied to route
  // registration, not a raw-URL string prefix, so a route added here later cannot
  // be left silently unauthenticated and a request only reaches these handlers
  // after both hooks have run. The compare is constant time.
  await app.register(async (secured) => {
    secured.addHook("onRequest", async (request, reply) => {
      if (!httpLimiter.allow(request.ip)) {
        return reply.code(429).send({ error: "rate limit exceeded" });
      }
    });
    secured.addHook("onRequest", async (request, reply) => {
      const token = bearerFrom(request.headers.authorization);
      if (!bearerMatches(token, config.bondBearer)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    });
    await secured.register(gatewayRoutes);
    await secured.register(agentRoutes);
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

  return app;
}

async function main(): Promise<void> {
  // Refuse to start on a configuration that must not reach a running server.
  assertStartupConfig();
  installCrashHandlers();

  const app = await buildApp();

  // The sync WebSocket server shares the same HTTP server.
  mountSync(app.server);

  // HOST defaults to 127.0.0.1, which keeps the plaintext port private behind a
  // TLS reverse proxy. An operator opens it on every interface deliberately with
  // HOST=0.0.0.0, never by forgetting to set it.
  await app.listen({ port: config.port, host: config.host });
}

// Only run the server when this module is the process entry, so importing it in a
// test starts nothing and installs no exiting handlers.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
