import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { gatewayRoutes } from "./gateway.js";
import { agentRoutes } from "./agent/route.js";
import { mountSync } from "./sync.js";

function bearerFrom(header?: string): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

// The exported web build lives beside this service in ../app/dist. Resolve it
// from this module so the path holds wherever the repo is checked out.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../app/dist");

async function main(): Promise<void> {
  const app = Fastify({
    logger: true,
    // Chat context can be large, so lift the body limit well above the 1 MB
    // default.
    bodyLimit: 16 * 1024 * 1024,
  });

  // Bearer auth on every /v1 route. Missing or wrong token is rejected before
  // the handler runs.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const token = bearerFrom(request.headers.authorization);
    if (!config.bondBearer || token !== config.bondBearer) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(gatewayRoutes);
  await app.register(agentRoutes);

  // Serve the web build as the same origin when it has been exported. Without
  // it the API still runs, the site just is not hosted here yet.
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.log.info(`serving web build from ${webDist}`);
  } else {
    app.log.warn(`web build not found at ${webDist}, skipping static host`);
  }

  // The sync WebSocket server shares the same HTTP server.
  mountSync(app.server);

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
