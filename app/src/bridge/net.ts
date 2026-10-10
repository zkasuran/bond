// A fetch that can stream a response body. React Native's built-in fetch cannot, so
// on device we use expo/fetch (WinterCG fetch with streaming). Under Node and in tests
// the global fetch already streams. Tests can inject a fake with setFetchImpl.
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

let injected: FetchLike | null = null;

/** Override the fetch used by adapters. For tests. */
export function setFetchImpl(f: FetchLike | null): void {
  injected = f;
}

export function getStreamingFetch(): FetchLike {
  if (injected) return injected;
  try {
    // expo/fetch streams response bodies on native and web
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expoFetch = (require("expo/fetch") as { fetch: FetchLike }).fetch;
    if (typeof expoFetch === "function") return expoFetch;
  } catch {
    // fall through to global fetch (Node, web)
  }
  const g = (globalThis as { fetch?: FetchLike }).fetch;
  if (!g) throw new Error("No fetch implementation available");
  return g;
}

/** Join a base URL and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/**
 * Whether it is safe to attach a bearer token to this base URL. Only over TLS (https/wss),
 * or to a loopback host over plaintext (local dev). A remote http:// or ws:// endpoint would
 * put the key on the wire in cleartext for any on-path observer, so the caller drops it.
 * Parsed with a regex, not the URL class, because React Native's URL is only a partial polyfill.
 */
export function allowBearer(baseUrl: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec((baseUrl ?? "").trim());
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  let host = m[2].toLowerCase();
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1); // strip userinfo
  if (host.startsWith("[")) {
    const rb = host.indexOf("]");
    if (rb !== -1) host = host.slice(0, rb + 1); // keep the ipv6 brackets, drop any port
  } else {
    const c = host.indexOf(":");
    if (c !== -1) host = host.slice(0, c); // drop the port
  }
  if (scheme === "https" || scheme === "wss") return true;
  if (scheme === "http" || scheme === "ws") {
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".localhost")
    );
  }
  return false;
}
