// The web build is a static export with one HTML file per route, including the dynamic ones
// ("room/[roomId].html"). A browser that reloads or deep-links a dynamic URL such as
// /room/01ABC asks for a file that does not exist, so without this the user got the API's raw
// JSON 404. This maps such a path to the export's own HTML for that route, and anything else
// that is not an API, sync or asset path to the export's not-found page, which hydrates the app.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface SpaRoute {
  /** Matches a URL path such as /room/01ABC/settings. */
  pattern: RegExp;
  /** The exported HTML file, relative to the dist root. */
  file: string;
}

/** Turn "room/[roomId]/settings.html" into a pattern. Static routes are served by the static
 *  plugin already, so only files with a [param] segment become routes here. Group folders like
 *  "(tabs)" are not part of the URL. */
export function routeFor(relFile: string): SpaRoute | null {
  if (!relFile.endsWith(".html") || !relFile.includes("[")) return null;
  const segs = relFile
    .replace(/\.html$/, "")
    .split("/")
    .filter((s) => !/^\(.*\)$/.test(s));
  if (segs.at(-1) === "index") segs.pop();
  const src = segs
    .map((s) => (/^\[\.\.\..+\]$/.test(s) ? ".+" : /^\[.+\]$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return { pattern: new RegExp(`^/${src}/?$`), file: relFile };
}

/** Every dynamic route in an exported dist, most specific (most segments) first. */
export function spaRoutes(distRoot: string): SpaRoute[] {
  const out: SpaRoute[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        const r = routeFor(path.relative(distRoot, abs).split(path.sep).join("/"));
        if (r) out.push(r);
      }
    }
  };
  if (existsSync(distRoot)) walk(distRoot);
  return out.sort((a, b) => b.file.split("/").length - a.file.split("/").length);
}

/** The HTML file to serve for a GET that matched no static file, or null to keep the 404.
 *  API, sync, well-known and asset-looking paths always keep their 404. */
export function spaFileFor(urlPath: string, routes: SpaRoute[], hasNotFound: boolean): string | null {
  if (/^\/(v1|sync|health|\.well-known|_expo|assets)(\/|$)/.test(urlPath)) return null;
  if (/\.[a-z0-9]{1,8}$/i.test(urlPath)) return null;
  for (const r of routes) if (r.pattern.test(urlPath)) return r.file;
  return hasNotFound ? "+not-found.html" : null;
}
