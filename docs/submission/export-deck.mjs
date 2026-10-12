#!/usr/bin/env node
// Export the motion deck (site/deck/) to a PDF: one settled 1920x1080 slide per page, with
// real selectable text, embedded fonts, live links and a bookmark outline built from the
// slide headings.
//
//   node docs/submission/export-deck.mjs              writes docs/submission/bond-deck.pdf
//   node docs/submission/export-deck.mjs other.pdf    writes somewhere else
//
// No new dependencies. It borrows Playwright from the app's dev dependencies:
//   (cd app && npm ci && npx playwright install chromium)
// It serves site/ itself on a loopback port and loads deck/?static, the motion-free final
// frames, so the PDF is exactly what the print stylesheet lays out.

import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const site = join(repo, "site");
const out = resolve(process.argv[2] ?? join(here, "bond-deck.pdf"));

const fromApp = createRequire(join(repo, "app", "package.json"));
let chromium;
try {
  ({ chromium } = fromApp("playwright"));
} catch {
  try {
    ({ chromium } = fromApp("@playwright/test"));
  } catch {
    console.error("Playwright not found. Run: cd app && npm ci && npx playwright install chromium");
    process.exit(1);
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// A read-only static server for site/, confined to that folder.
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let file = normalize(join(site, path));
    if (file !== site && !file.startsWith(site + sep)) {
      res.writeHead(403).end();
      return;
    }
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`); });
  page.on("requestfailed", (r) => problems.push(`failed ${r.url()}`));

  await page.goto(`${base}/deck/?static#/1`, { waitUntil: "networkidle" });
  // Every face and every image, not just the ones on the first slide.
  const slides = await page.evaluate(async () => {
    await Promise.all(Array.from(document.fonts, (f) => f.load().catch(() => {})));
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (img) => img.decode().catch(() => {})));
    return document.querySelectorAll(".slide").length;
  });
  if (problems.length) throw new Error("The deck did not load cleanly:\n  " + problems.join("\n  "));
  // The deck's own print preparation: final frames, and every slide back in the accessibility tree.
  await page.evaluate(() => dispatchEvent(new Event("beforeprint")));

  // Render to memory and check everything first, so a failed run never overwrites a good PDF.
  const pdf = await page.pdf({
    width: "1920px",
    height: "1080px",
    preferCSSPageSize: true,
    printBackground: true,
    outline: true,
    tagged: true,
  });
  if (problems.length) throw new Error("The deck reported problems while printing:\n  " + problems.join("\n  "));
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  if (pages !== slides) throw new Error(`Expected ${slides} pages, one per slide, but the PDF has ${pages}.`);

  await writeFile(out, pdf);
  console.log(`Wrote ${out}: ${pages} pages, ${(pdf.length / 1048576).toFixed(2)} MB`);
} finally {
  await browser.close();
  server.close();
}
