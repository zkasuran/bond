import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeFor, spaFileFor, spaRoutes } from "./spa.js";

test("routeFor maps dynamic export files and skips static ones and groups", () => {
  assert.equal(routeFor("index.html"), null);
  assert.equal(routeFor("market/index.html"), null);
  assert.ok(routeFor("room/[roomId].html")!.pattern.test("/room/01ABC"));
  assert.ok(!routeFor("room/[roomId].html")!.pattern.test("/room/01ABC/settings"));
  assert.ok(routeFor("room/[roomId]/settings.html")!.pattern.test("/room/x/settings"));
  assert.ok(routeFor("(tabs)/thing/[id].html")!.pattern.test("/thing/7"));
});

test("spaFileFor picks the most specific route, keeps API and asset 404s", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spa-"));
  mkdirSync(path.join(dir, "room", "[roomId]"), { recursive: true });
  mkdirSync(path.join(dir, "market"), { recursive: true });
  for (const f of ["room/[roomId].html", "room/[roomId]/settings.html", "market/[id].html", "+not-found.html", "index.html"]) writeFileSync(path.join(dir, f), "<html></html>");
  const routes = spaRoutes(dir);
  assert.equal(spaFileFor("/room/01ABC", routes, true), "room/[roomId].html");
  assert.equal(spaFileFor("/room/01ABC/settings", routes, true), "room/[roomId]/settings.html");
  assert.equal(spaFileFor("/market/nope", routes, true), "market/[id].html");
  assert.equal(spaFileFor("/totally/unknown", routes, true), "+not-found.html");
  for (const p of ["/v1/nope", "/sync", "/health", "/.well-known/x", "/_expo/static/x.js", "/missing.js", "/a.png"]) assert.equal(spaFileFor(p, routes, true), null, p);
  assert.equal(spaFileFor("/totally/unknown", routes, false), null);
});
