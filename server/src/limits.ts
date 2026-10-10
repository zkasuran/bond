// Every ceiling the server enforces, in one place. A hostile client, a hostile
// upstream or a runaway model must never exhaust memory, CPU or funds, so each
// limit below is a named constant rather than a literal buried in a handler.
// Change a value here and it changes everywhere the limit is checked.

// --- Sync WebSocket ---------------------------------------------------------

// Largest single WebSocket frame the sync server accepts. Passed as maxPayload
// to the WebSocketServer so the ws library closes an oversized frame itself (the
// library default is 100 MB).
export const MAX_NODE_BYTES = 64 * 1024;

// Most rooms held at once. A new room past this is refused at upgrade time.
export const MAX_ROOMS = 500;

// Most nodes stored per room. Past this the oldest node is evicted so the store
// stays bounded while sync keeps working.
export const MAX_NODES_PER_ROOM = 5000;

// Per-socket message token bucket. Burst is the bucket size, rate is the refill
// per second. A socket over its budget has the offending message dropped.
export const SYNC_MSG_BURST = 60;
export const SYNC_MSG_PER_SEC = 30;

// Per-socket byte token bucket, same shape, counted on the raw frame size.
export const SYNC_BYTES_BURST = 1024 * 1024;
export const SYNC_BYTES_PER_SEC = 512 * 1024;

// Per-IP upgrade token bucket. Caps how fast one address can open sockets.
export const SYNC_UPGRADE_BURST = 10;
export const SYNC_UPGRADE_PER_SEC = 5;

// Largest unflushed outbound buffer the sync server holds for one socket. A
// reader that stops draining (or a hostile client that never reads) must not
// force the server to buffer a whole room in memory. Past this the server stops
// feeding that socket and waits for it to drain, then drops it if it never does.
export const MAX_SOCKET_BUFFER_BYTES = 512 * 1024;

// How long a backed-up socket may sit above the buffer ceiling before it is
// dropped, polled at this interval. A reader that drains inside the window keeps
// its replay, one that never drains is terminated so its memory is freed.
export const SOCKET_DRAIN_TIMEOUT_MS = 2_000;
export const SOCKET_DRAIN_POLL_MS = 50;

// Most live sync sockets in one room, plus a ceiling in total across every room.
// The per-room cap stops one room id being used to open unbounded sockets, the
// global cap bounds total file descriptors and memory. Both are enforced at
// upgrade, reconnects included, so an existing room no longer skips the ceiling.
export const MAX_SOCKETS_PER_ROOM = 100;
export const MAX_TOTAL_SOCKETS = 2_000;

// Global ceiling on bytes retained across every room's store, so the per-room and
// per-node ceilings cannot multiply into an unbounded total. Past it a new node
// is still relayed to live peers but not retained, so memory stays bounded.
export const MAX_TOTAL_STORE_BYTES = 256 * 1024 * 1024;

// --- Gateway proxy ----------------------------------------------------------

// How long an upstream request may take to send its response headers before the
// fetch is aborted. The response body is bounded by MAX_UPSTREAM_BYTES instead,
// so a long legitimate stream is not cut off by this timeout.
export const UPSTREAM_TIMEOUT_MS = 30_000;

// Largest upstream response the proxy will relay. The stream is destroyed past
// this so a hostile or broken upstream cannot stream without end.
export const MAX_UPSTREAM_BYTES = 16 * 1024 * 1024;

// Most upstream proxy requests in flight at once. Past this the proxy returns
// 503 rather than opening unbounded sockets to the upstream.
export const MAX_CONCURRENT_UPSTREAM = 24;

// --- HTTP rate limit (/v1/*) ------------------------------------------------

// Per-IP request token bucket for the /v1 surface.
export const HTTP_RATE_BURST = 120;
export const HTTP_RATE_PER_SEC = 10;

// Upper bound on tracked rate-limit keys so the limiter map cannot grow without
// end under a spoofed-IP flood.
export const MAX_RATE_LIMIT_KEYS = 10_000;

// --- Agent ------------------------------------------------------------------

// Hard per-transfer cap on the unattended USDC transfer tool, in whole USDC.
export const MAX_AGENT_TRANSFER_USDC = 100;

// Cumulative per-process ceiling across every successful transfer, in whole
// USDC. Reached, the tool refuses further transfers until the process restarts.
export const MAX_AGENT_TRANSFER_TOTAL_USDC = 500;

// Hard ceiling on tool-calling steps in one turn. Neither the client request nor
// the environment can push the loop past this.
export const MAX_AGENT_STEPS = 8;

// A refilling token bucket. take(n) succeeds and spends n tokens when at least n
// are available, otherwise it fails and spends nothing.
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  take(n = 1): boolean {
    const now = Date.now();
    const refill = ((now - this.last) / 1000) * this.refillPerSec;
    this.tokens = Math.min(this.capacity, this.tokens + refill);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  isFull(): boolean {
    const now = Date.now();
    const refill = ((now - this.last) / 1000) * this.refillPerSec;
    return Math.min(this.capacity, this.tokens + refill) >= this.capacity;
  }
}

// A token bucket per key (an IP, usually), with the map of keys itself bounded.
// When the map is full the idle (refilled) buckets are pruned first. If every
// bucket is still active the map is cleared, which only resets limiter state and
// never grants more than one burst.
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly maxKeys: number,
  ) {}

  allow(key: string, n = 1): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.prune();
      bucket = new TokenBucket(this.capacity, this.refillPerSec);
      this.buckets.set(key, bucket);
    }
    return bucket.take(n);
  }

  private prune(): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull()) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}
