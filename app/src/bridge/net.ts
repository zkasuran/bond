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
