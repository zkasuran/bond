// The app side of Bond's /sync WebSocket. One room, one socket. The server at /sync is a
// dumb relay: it stores a node by id, replays nodes past a lamport then fans a node out to
// the other members of a room. It never checks a signature. So this client treats every
// inbound node as untrusted input. It hands each one to the Storage port, where the verify
// gate in store/guard.ts decides what is stored and what is presentable: a tampered node is
// dropped, an unsigned node is kept but never shown as verified. This client adds the
// network. It never widens what the gate trusts.
//
// Honest scope: the true claim is that a relayed node is re-verified locally then a tampered
// one is dropped. The relay itself is best effort. A node created while the socket is down
// stays in the local log then rides out on the next connect. It is dropped from the send
// queue only once that queue is full. Nothing here signs or weakens a signature.
import type { BondNode } from "../model/node";

// A node frame whose UTF-8 size exceeds this is dropped before it is parsed then stored. The
// server caps a frame at 64 KB (MAX_NODE_BYTES) so an honest frame is always smaller. The
// platform WebSocket materializes the whole frame before this code runs, so this bounds what
// the client parses and stores, not what the socket buffers. True pre-receive rejection needs
// a native max-payload that the browser then React Native WebSocket do not expose.
export const MAX_INBOUND_BYTES = 64 * 1024;

// Inbound flood ceiling. At most this many node frames are ingested per window; past it a
// relay's frames are dropped until the window rolls, so a relay cannot grow local storage
// without bound. Sized well above an honest hello replay plus live traffic for one room.
export const MAX_INBOUND_NODES_PER_WINDOW = 500;
export const INBOUND_WINDOW_MS = 10_000;

// Largest number of node frames held while the socket is down. Past this the oldest queued
// frame is dropped, so a long offline spell cannot grow memory without end. The node stays
// in the local store regardless. Only its relay to peers is best effort.
export const MAX_OUTBOUND_QUEUE = 256;

// Reconnect backoff. The delay doubles each failed attempt from the base, capped so it never
// grows without end then never collapses to a tight loop.
export const BASE_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 30_000;
const BACKOFF_JITTER_MS = 250;

// A socket that never reaches OPEN inside this window is torn down then retried, so a half
// open connection cannot sit forever.
const CONNECT_TIMEOUT_MS = 15_000;

// A connection must stay open at least this long before a success resets the backoff. A relay
// that accepts the socket then closes it at once never clears this bar, so the client keeps
// backing off instead of spinning at the base delay.
const STABLE_CONNECTION_MS = 5_000;

// A socket that receives nothing for this long is assumed dead then reconnected. A silently
// dropped TCP connection fires no close event, so this watchdog is the only thing that
// recovers it. On a genuinely quiet room this costs one reconnect per window, which is
// bounded, cheap and correct because the reconnect's hello replays anything that was missed.
const IDLE_TIMEOUT_MS = 70_000;

// WebSocket.OPEN. Pinned as a literal so this module does not depend on the global being
// present at import time (it is absent under jest unless a test supplies it).
const WS_OPEN = 1;

/** Capped exponential backoff for attempt n (0-based). Pure, so the bound is testable. */
export function computeBackoff(attempt: number): number {
  const n = attempt > 0 ? attempt : 0;
  const raw = BASE_BACKOFF_MS * 2 ** n;
  return raw < MAX_BACKOFF_MS ? raw : MAX_BACKOFF_MS;
}

/** True when the UTF-8 byte length of `s` exceeds `cap`. The size check compares bytes, not
 *  UTF-16 code units, so a multibyte frame cannot carry more than `cap` bytes past a plain
 *  length check. The loop early-exits once it passes the cap, so it runs at most cap+1 steps
 *  whatever the string length. */
function overByteCap(s: string, cap: number): boolean {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      bytes += 4;
      i += 1; // a surrogate pair is one code point of four UTF-8 bytes
    } else bytes += 3;
    if (bytes > cap) return true;
  }
  return false;
}
/**
 * Derive the sync WebSocket origin from the configured gateway base. The gateway base is an
 * http(s) URL ending in /v1 (see EXPO_PUBLIC_BOND_GATEWAY). Swap the scheme for ws(s) then the
 * /v1 API path for the /sync path the server mounts. A base with no /v1 gets /sync appended.
 * The scheme match is case-insensitive, https maps to the secure wss, then a base that is not
 * http(s) is refused rather than passed through unupgraded (a cleartext or junk scheme would
 * leak the token or build an invalid URL).
 */
export function syncUrlFromGateway(baseUrl: string): string {
  let s = baseUrl.trim().replace(/\/+$/, "");
  const scheme = s.slice(0, s.indexOf("://")).toLowerCase();
  if (scheme === "https") s = "wss://" + s.slice("https://".length);
  else if (scheme === "http") s = "ws://" + s.slice("http://".length);
  else throw new Error("sync gateway base must be an http(s) URL");
  if (/\/v1$/.test(s)) s = s.replace(/\/v1$/, "/sync");
  else s = s + "/sync";
  return s;
}

/** The full ws URL for a room: the derived /sync origin plus the room then the bearer token.
 *  The token rides as ?token= because neither the browser nor the React Native WebSocket can
 *  set an Authorization header. The server accepts the token from either (see
 *  server/src/sync.ts). This token is the EXPO_PUBLIC device token, already shipped inside the
 *  client bundle, not a server secret. */
export function syncUrl(baseUrl: string, roomId: string, token?: string): string {
  const base = syncUrlFromGateway(baseUrl);
  const sep = base.includes("?") ? "&" : "?";
  const q =
    `room=${encodeURIComponent(roomId)}` +
    (token ? `&token=${encodeURIComponent(token)}` : "");
  return `${base}${sep}${q}`;
}

/** The minimal WebSocket surface this client uses. Both the browser / React Native WebSocket
 *  and a test double satisfy it, so neither the runtime nor jest needs the full DOM type. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}
export interface SyncClientOptions {
  /** The gateway base, e.g. http://localhost:8080/v1. The ws URL is derived from it. */
  gatewayBaseUrl: string;
  /** The shared device bearer token, presented as ?token=. May be undefined in dev. */
  token: string | undefined;
  roomId: string;
  /** Hand one untrusted inbound node to the Storage port. The gate there decides its fate. A
   *  throw or rejection here is caught so one bad node never tears the socket down. */
  onRemoteNode: (node: BondNode) => void | Promise<void>;
  /** Highest lamport already stored for the room, so hello only replays what is missing. */
  sinceLamport: () => number | Promise<number>;
  /** Builds a socket for a url. Defaults to the global WebSocket so a test can mock it. */
  socketFactory?: (url: string) => SocketLike;
  /** Jitter source for backoff, injectable so a test gets deterministic delays. */
  random?: () => number;
  /** Clock for the inbound rate window, injectable so a flood test is deterministic.
   *  Defaults to Date.now. */
  now?: () => number;
}

/** True when a WebSocket implementation exists in this runtime. The store checks this before
 *  starting sync so the app stays fully functional with no socket (the web export, jest, a
 *  device with no network stack), local-first as the default. */
export function isSyncAvailable(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "undefined";
}

function defaultSocketFactory(url: string): SocketLike {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => SocketLike }).WebSocket;
  if (!Ctor) throw new Error("WebSocket is not available in this runtime");
  return new Ctor(url);
}

/** Shape guard for an inbound node. The signature gate lives in the store, not here, but the
 *  read path dereferences id, roomId, lamport, author.did, parentId then type with no guards
 *  of its own, so a malformed relay frame must be refused at this boundary before it reaches
 *  the store. This is verify-don't-trust on the wire shape, not on the signature. */
export function looksLikeBondNode(x: unknown, roomId: string): x is BondNode {
  if (!x || typeof x !== "object") return false;
  const n = x as Record<string, unknown>;
  if (typeof n.id !== "string" || n.id.length === 0) return false;
  if (n.roomId !== roomId) return false;
  if (typeof n.lamport !== "number" || !Number.isFinite(n.lamport)) return false;
  if (!(n.parentId === null || typeof n.parentId === "string")) return false;
  if (typeof n.type !== "string") return false;
  if (typeof n.payload === "undefined") return false;
  const author = n.author as Record<string, unknown> | undefined;
  if (!author || typeof author.did !== "string") return false;
  return true;
}
/**
 * One room's sync socket. start() connects then keeps the connection up with capped backoff,
 * broadcast() sends a locally created node, stop() tears everything down. Inbound nodes are
 * handed to onRemoteNode (the Storage port) rather than trusted here.
 */
export class SyncClient {
  private readonly opts: SyncClientOptions;
  private readonly makeSocket: (url: string) => SocketLike;
  private readonly random: () => number;
  private readonly now: () => number;

  private running = false;
  private socket: SocketLike | null = null;
  private attempt = 0;
  private outbound: string[] = [];
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private windowStart = 0;
  private windowCount = 0;

  constructor(opts: SyncClientOptions) {
    this.opts = opts;
    this.makeSocket = opts.socketFactory ?? defaultSocketFactory;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.running = false;
    this.clearTimer("reconnectTimer");
    this.clearTimer("connectTimer");
    this.clearTimer("idleTimer");
    this.clearTimer("stableTimer");
    const sock = this.socket;
    this.socket = null;
    if (sock) this.safeClose(sock);
    this.outbound = [];
  }

  /** Send a locally created node to the room. While the socket is down the frame is queued,
   *  bounded, so it rides out on the next connect. The node is in the local store either way. */
  broadcast(node: BondNode): void {
    const frame = JSON.stringify({ type: "node", node });
    const sock = this.socket;
    if (sock && sock.readyState === WS_OPEN) {
      try {
        sock.send(frame);
        return;
      } catch {
        // Fall through then queue it; the reconnect path flushes it.
      }
    }
    this.outbound.push(frame);
    while (this.outbound.length > MAX_OUTBOUND_QUEUE) this.outbound.shift();
  }
  private open(): void {
    if (!this.running) return;
    let sock: SocketLike;
    try {
      sock = this.makeSocket(syncUrl(this.opts.gatewayBaseUrl, this.opts.roomId, this.opts.token));
    } catch {
      // No socket could be built (no WebSocket in this runtime, a bad url). Back off then
      // retry rather than throw into the caller: sync is additive, the app runs without it.
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    this.armConnectTimeout();
    sock.onopen = () => this.handleOpen(sock);
    sock.onmessage = (ev) => this.handleMessage(sock, ev);
    sock.onerror = () => this.handleDown(sock);
    sock.onclose = () => this.handleDown(sock);
  }

  private handleOpen(sock: SocketLike): void {
    if (sock !== this.socket) return;
    this.clearTimer("connectTimer");
    this.armStable(sock); // reset the backoff only once this stays open, not on a bare accept
    this.armIdle();
    void this.sendHello(sock);
    this.flushOutbound(sock);
  }

  private handleMessage(sock: SocketLike, ev: { data: unknown }): void {
    if (sock !== this.socket) return;
    this.armIdle(); // any inbound frame proves the socket is live
    const data = ev?.data;
    if (typeof data !== "string") return; // the client only speaks the JSON text protocol
    if (overByteCap(data, MAX_INBOUND_BYTES)) return; // oversized frame dropped before parse then store
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.type !== "node") return; // hello replay then live fan-out both arrive as node frames
    if (!looksLikeBondNode(m.node, this.opts.roomId)) return;
    if (this.overInboundRate()) return; // flood: drop past the per-window ceiling
    this.ingest(m.node);
  }
  private ingest(node: BondNode): void {
    try {
      const r = this.opts.onRemoteNode(node);
      if (r && typeof (r as Promise<void>).then === "function") {
        (r as Promise<void>).catch(() => {});
      }
    } catch {
      // The Storage port rejected or threw. The gate dropping a node is a normal outcome,
      // never a reason to drop the socket.
    }
  }

  /** True when the inbound node-frame ceiling for the current window is already reached. The
   *  window rolls on the injected clock, so a steady honest stream is never blocked but a
   *  relay flood is capped and the surplus is dropped. */
  private overInboundRate(): boolean {
    const t = this.now();
    if (t - this.windowStart >= INBOUND_WINDOW_MS) {
      this.windowStart = t;
      this.windowCount = 0;
    }
    if (this.windowCount >= MAX_INBOUND_NODES_PER_WINDOW) return true;
    this.windowCount += 1;
    return false;
  }

  private async sendHello(sock: SocketLike): Promise<void> {
    let since = 0;
    try {
      since = await this.opts.sinceLamport();
    } catch {
      since = 0;
    }
    if (sock !== this.socket || sock.readyState !== WS_OPEN) return;
    try {
      sock.send(JSON.stringify({ type: "hello", lastLamport: since }));
    } catch {
      // The socket closed between the await then here. The down handler reconnects.
    }
  }

  private flushOutbound(sock: SocketLike): void {
    if (sock.readyState !== WS_OPEN) return;
    const pending = this.outbound;
    this.outbound = [];
    for (const frame of pending) {
      try {
        sock.send(frame);
      } catch {
        // Best effort. A failed flush does not requeue; the node stays in the local store.
      }
    }
  }

  private handleDown(sock: SocketLike): void {
    // Only the live socket drives a reconnect, so onerror then onclose on one socket schedule
    // exactly one retry.
    if (sock !== this.socket) return;
    this.socket = null;
    this.clearTimer("connectTimer");
    this.clearTimer("idleTimer");
    this.clearTimer("stableTimer");
    this.safeClose(sock);
    this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return; // one retry in flight at a time, so this cannot spin
    const delay = computeBackoff(this.attempt) + Math.floor(this.random() * BACKOFF_JITTER_MS);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private armConnectTimeout(): void {
    this.clearTimer("connectTimer");
    this.connectTimer = setTimeout(() => {
      // handleOpen clears this timer, so reaching here means the socket never opened.
      const sock = this.socket;
      if (sock) this.handleDown(sock);
    }, CONNECT_TIMEOUT_MS);
  }

  private armIdle(): void {
    this.clearTimer("idleTimer");
    this.idleTimer = setTimeout(() => {
      const sock = this.socket;
      if (sock) this.handleDown(sock);
    }, IDLE_TIMEOUT_MS);
  }

  private armStable(sock: SocketLike): void {
    this.clearTimer("stableTimer");
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      // Only a connection that stayed open this long is treated as real progress, so an
      // accept-then-close relay never clears the backoff.
      if (sock === this.socket) this.attempt = 0;
    }, STABLE_CONNECTION_MS);
  }

  private clearTimer(which: "connectTimer" | "idleTimer" | "reconnectTimer" | "stableTimer"): void {
    const t = this[which];
    if (t) {
      clearTimeout(t);
      this[which] = null;
    }
  }

  private safeClose(sock: SocketLike): void {
    try {
      sock.close();
    } catch {
      // Already closed or closing. Nothing to do.
    }
  }
}

export function createSyncClient(opts: SyncClientOptions): SyncClient {
  return new SyncClient(opts);
}

