// The Bond app engine: a zustand store tying identity, the append-only log, the agent
// bridges and thread routing together. Local-first: a node is written and shown
// immediately, agents stream their replies in-thread. See DESIGN.md sec 6 and 9.
import { create } from "zustand";
import { ulid } from "ulidx";
import type { BondNode, Identity } from "../model/node";
import type { PayloadMap } from "../model/messages";
import type {
  AdapterKind,
  GatewayAdapter,
  GatewayCapabilities,
  GatewayConfig,
} from "../bridge/adapter";
import type { Membership } from "../rooms/roles";
import { makeAdapter } from "../bridge/registry";
import { createStorage, type Storage } from "../store";
import { loadOrCreateIdentity } from "../identity/storage";
import { makeNode } from "../model/factory";
import { nextLamport } from "../model/thread";
import { branchToLeaf, createSignedNode, maxLamport } from "./engine";
import { agentMentions, threadToChatMessages } from "../rooms/routing";
import type { SyncClient } from "../sync/client";
import { useSkills } from "../skills/registry";
import { signBytes } from "../identity/keys";
import { base64urlnopad } from "@scure/base";
import { useWallet } from "../solana/store";
import type { WalletBinding } from "../solana/binding";

const BOND_AGENT_DID = "did:bond:assistant";
const SYSTEM_PROMPT =
  "You are an agent inside Bond, a messaging app where humans and agents share a room. " +
  "You are replying within a thread. Be concise, direct and useful.";

const KEY_ROOMS = "bond.rooms";
const KEY_MEMBERS = "bond.members";
const KEY_BRIDGES = "bond.bridges";
const KEY_RUNS = "bond.monthlyRuns";

function defaultBondConfig(): GatewayConfig {
  return {
    baseUrl: process.env.EXPO_PUBLIC_BOND_GATEWAY ?? "http://localhost:8080/v1",
    apiKey: process.env.EXPO_PUBLIC_BOND_TOKEN,
    model: process.env.EXPO_PUBLIC_BOND_MODEL,
  };
}

// A skill claim carries a wallet-ownership proof (F14 HIGH): the device did:key signs a fresh
// server challenge over the skill id, the purchase signature and the paying wallet, and a
// one-time wallet-signed binding ties that did:key to the paying wallet. The server rebuilds
// the message and verifies both signatures against the on-chain payer, so naming the payer is
// not enough to unlock a skill.
interface SkillClaimWire {
  id: string;
  signature: string;
  buyer: string;
  proof: { challenge: string; did: string; didSig: string; binding: WalletBinding };
}

// The exact bytes the server rebuilds and verifies against the device did:key. Must match
// server/src/agent/skills.ts claimMessageBytes.
function skillClaimMessage(id: string, txSignature: string, buyer: string, challenge: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "Bond skill claim v1",
      `skill: ${id}`,
      `tx: ${txSignature}`,
      `buyer: ${buyer}`,
      `challenge: ${challenge}`,
    ].join("\n"),
  );
}

// Fetch a fresh, short-lived freshness challenge from the Bond gateway. Null on any failure,
// which makes the caller send no proof, so skills fail closed rather than unlock stale.
async function fetchSkillChallenge(): Promise<string | null> {
  try {
    const cfg = defaultBondConfig();
    const base = cfg.baseUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/agent/skill-challenge`, {
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { challenge?: unknown };
    return typeof body.challenge === "string" ? body.challenge : null;
  } catch {
    return null;
  }
}

// Build each installed skill's purchase claim with a fresh wallet-ownership proof. Returns an
// empty list, so no skill unlocks, whenever ownership cannot be proven: no identity key, no
// wallet binding for this device, or no fresh challenge. The device did:key signs silently, so
// this costs no wallet prompt per turn; the wallet signed once, in the stored binding.
async function buildSkillClaims(
  identity: Identity | null,
  secretKey: Uint8Array | null,
): Promise<SkillClaimWire[]> {
  if (!identity || !secretKey) return [];
  await useSkills.getState().load().catch(() => {});
  const entitlements = Object.values(useSkills.getState().entitlements);
  if (entitlements.length === 0) return [];
  await useWallet.getState().loadStoredBinding(identity.did).catch(() => {});
  const binding = useWallet.getState().binding;
  if (!binding || binding.did !== identity.did) return [];
  const challenge = await fetchSkillChallenge();
  if (!challenge) return [];
  const claims: SkillClaimWire[] = [];
  for (const e of entitlements) {
    // Only a purchase paid by the bound wallet can be proven, so skip any other.
    if (e.buyer !== binding.walletAddress) continue;
    const didSig = base64urlnopad.encode(
      signBytes(skillClaimMessage(e.skillId, e.signature, e.buyer, challenge), secretKey),
    );
    claims.push({
      id: e.skillId,
      signature: e.signature,
      buyer: e.buyer,
      proof: { challenge, did: identity.did, didSig, binding },
    });
  }
  return claims;
}

// Live /sync sockets, keyed by room. Kept outside the zustand state because a socket is not
// serializable render state: it is wiring. Sync is additive and local-first, so a room with
// no entry here still works entirely from the local log. See src/sync/client.ts.
const syncClients = new Map<string, SyncClient>();

// Relay a locally created node to the room's peers, when a socket is open. A no-op when sync
// is off or the room has no client, so every call site stays a one-liner that is safe with
// sync disabled.
function broadcastNode(roomId: string, node: BondNode): void {
  syncClients.get(roomId)?.broadcast(node);
}

export interface Room {
  id: string;
  title: string;
  createdAt: string;
}

export interface Bridge {
  id: string;
  kind: AdapterKind;
  displayName: string;
  config: GatewayConfig;
  capabilities?: GatewayCapabilities;
  status: "connecting" | "connected" | "error";
  error?: string;
  adapter: GatewayAdapter;
}

interface StoredBridge {
  id: string;
  kind: AdapterKind;
  displayName: string;
  config: GatewayConfig;
}

// A live, read-only view of SKR on Solana mainnet: the connected wallet's SKR balance and
// the price of one SKR in USDC. SKR never moves and nothing is signed against it; this only
// reads mainnet, the same class as the Jupiter quote the Wallet screen shows. The market uses
// isHolder to gate a bounded, creator-set discount on the devnet-USDC skill price.
export interface SkrTouchpointState {
  balanceUi: string;
  priceInUsdc: number;
  isHolder: boolean;
  loading: boolean;
  error: string | null;
}
export interface BondState {
  ready: boolean;
  identity: Identity | null;
  secretKey: Uint8Array | null;
  assurance: "device" | "web" | null;
  storage: Storage | null;
  rooms: Room[];
  members: Record<string, Membership[]>;
  nodes: Record<string, BondNode[]>;
  bridges: Bridge[];
  /** nodeId -> true while an agent reply is still streaming into it. */
  streaming: Record<string, boolean>;
  monthlyRuns: number;
  onboarded: boolean;
  /** Live, read-only SKR mainnet view. Null before the first read. */
  skr: SkrTouchpointState | null;

  init: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
  createRoom: (title: string) => Promise<Room>;
  postText: (
    roomId: string,
    parentId: string | null,
    body: string,
    mentions?: string[],
  ) => Promise<BondNode>;
  connectBridge: (
    kind: AdapterKind,
    config: GatewayConfig,
    displayName?: string,
  ) => Promise<Bridge>;
  addAgentToRoom: (roomId: string, bridge: Bridge, displayName: string) => Promise<void>;
  runAgentTurn: (roomId: string, mentionNodeId: string, agent: Membership) => Promise<void>;
  sendPayment: (
    roomId: string,
    parentId: string | null,
    toAddress: string,
    uiAmount: string,
    memo?: string,
  ) => Promise<BondNode>;
  /** Read the connected wallet's SKR balance and a live SKR price from mainnet. Read-only:
   *  no SKR moves and nothing is signed. Pass null to refresh the price with no balance. */
  refreshSkr: (ownerAddress: string | null) => Promise<void>;
  /** Open the live /sync socket for a room so humans and agents on other devices become peers
   *  in the same room. Additive and local-first: if sync is unavailable or the socket fails,
   *  the room still works entirely from the local log. Safe to call more than once per room. */
  openRoomSync: (roomId: string) => Promise<void>;
  /** Close a room's /sync socket. Called when the room screen unmounts. */
  closeRoomSync: (roomId: string) => void;
}

function selfMembership(id: Identity): Membership {
  return {
    did: id.did,
    displayName: id.displayName,
    kind: "human",
    role: "owner",
    joinedAt: new Date().toISOString(),
  };
}

function bondAgentMembership(bridgeId: string): Membership {
  return {
    did: BOND_AGENT_DID,
    displayName: "Bond",
    kind: "agent",
    role: "agent",
    joinedAt: new Date().toISOString(),
    bridgeId,
  };
}
export const useBond = create<BondState>((set, get) => ({
  ready: false,
  identity: null,
  secretKey: null,
  assurance: null,
  storage: null,
  rooms: [],
  members: {},
  nodes: {},
  bridges: [],
  streaming: {},
  monthlyRuns: 0,
  onboarded: false,
  skr: null,

  init: async () => {
    if (get().ready) return;
    const stored = await loadOrCreateIdentity();
    const storage = createStorage();
    const rooms = (await storage.getItem<Room[]>(KEY_ROOMS)) ?? [];
    const members = (await storage.getItem<Record<string, Membership[]>>(KEY_MEMBERS)) ?? {};
    const monthlyRuns = (await storage.getItem<number>(KEY_RUNS)) ?? 0;
    const onboarded = (await storage.getItem<boolean>("bond.onboarded")) ?? false;
    const nodes: Record<string, BondNode[]> = {};
    for (const r of rooms) nodes[r.id] = await storage.nodesForRoom(r.id);

    const bond = makeAdapter("bond");
    const config = defaultBondConfig();
    const bondBridge: Bridge = {
      id: "bond",
      kind: "bond",
      displayName: "Bond gateway",
      config,
      status: "connecting",
      adapter: bond,
    };
    set({
      identity: stored.identity,
      secretKey: stored.secretKey,
      assurance: stored.assurance,
      storage,
      rooms,
      members,
      nodes,
      monthlyRuns,
      onboarded,
      bridges: [bondBridge],
      ready: true,
    });
    try {
      const caps = await bond.connect(config);
      set((s) => ({
        bridges: s.bridges.map((b) =>
          b.id === "bond" ? { ...b, status: "connected", capabilities: caps } : b,
        ),
      }));
    } catch (e) {
      set((s) => ({
        bridges: s.bridges.map((b) =>
          b.id === "bond"
            ? { ...b, status: "error", error: String((e as Error)?.message ?? e) }
            : b,
        ),
      }));
    }
    const saved = (await storage.getItem<StoredBridge[]>(KEY_BRIDGES)) ?? [];
    for (const sb of saved) {
      void get().connectBridge(sb.kind, sb.config, sb.displayName);
    }
  },
  createRoom: async (title) => {
    const { identity, storage } = get();
    if (!identity || !storage) throw new Error("Bond is not ready");
    const room: Room = {
      id: ulid(),
      title: title.trim() || "New room",
      createdAt: new Date().toISOString(),
    };
    const mem = [selfMembership(identity), bondAgentMembership("bond")];
    set((s) => ({
      rooms: [room, ...s.rooms],
      members: { ...s.members, [room.id]: mem },
      nodes: { ...s.nodes, [room.id]: [] },
    }));
    await storage.setItem(KEY_ROOMS, get().rooms);
    await storage.setItem(KEY_MEMBERS, get().members);
    return room;
  },

  postText: async (roomId, parentId, body, mentions) => {
    const { identity, secretKey, storage } = get();
    if (!identity || !secretKey || !storage) throw new Error("Bond is not ready");
    const roomNodes = get().nodes[roomId] ?? [];
    const lamport = nextLamport(maxLamport(roomNodes));
    const node = createSignedNode(
      { roomId, parentId, author: identity, type: "text", payload: { body, mentions }, lamport },
      secretKey,
    );
    await storage.append(node);
    set((s) => ({ nodes: { ...s.nodes, [roomId]: [...(s.nodes[roomId] ?? []), node] } }));
    broadcastNode(roomId, node);
    const agents = agentMentions(node, get().members[roomId] ?? []);
    await Promise.all(agents.map((a) => get().runAgentTurn(roomId, node.id, a)));
    return node;
  },

  connectBridge: async (kind, config, displayName) => {
    const adapter = makeAdapter(kind);
    const id = kind === "bond" ? "bond" : `${kind}-${ulid()}`;
    const bridge: Bridge = {
      id,
      kind,
      displayName: displayName ?? adapter.displayName,
      config,
      status: "connecting",
      adapter,
    };
    set((s) => ({ bridges: [...s.bridges.filter((b) => b.id !== id), bridge] }));
    try {
      const caps = await adapter.connect(config);
      set((s) => ({
        bridges: s.bridges.map((b) =>
          b.id === id ? { ...b, status: "connected", capabilities: caps } : b,
        ),
      }));
    } catch (e) {
      set((s) => ({
        bridges: s.bridges.map((b) =>
          b.id === id
            ? { ...b, status: "error", error: String((e as Error)?.message ?? e) }
            : b,
        ),
      }));
    }
    const storage = get().storage;
    if (storage) {
      const persistable: StoredBridge[] = get()
        .bridges.filter((b) => b.kind !== "bond")
        .map((b) => ({ id: b.id, kind: b.kind, displayName: b.displayName, config: b.config }));
      await storage.setItem(KEY_BRIDGES, persistable);
    }
    return get().bridges.find((b) => b.id === id) as Bridge;
  },

  addAgentToRoom: async (roomId, bridge, displayName) => {
    const storage = get().storage;
    const mem: Membership = {
      did: `did:bond:agent:${bridge.id}`,
      displayName,
      kind: "agent",
      role: "agent",
      joinedAt: new Date().toISOString(),
      bridgeId: bridge.id,
    };
    set((s) => ({ members: { ...s.members, [roomId]: [...(s.members[roomId] ?? []), mem] } }));
    if (storage) await storage.setItem(KEY_MEMBERS, get().members);
  },

  completeOnboarding: async () => {
    set({ onboarded: true });
    const storage = get().storage;
    if (storage) await storage.setItem("bond.onboarded", true);
  },

  runAgentTurn: async (roomId, mentionNodeId, agent) => {
    const { storage } = get();
    if (!storage) return;
    const bridge =
      get().bridges.find((b) => b.id === agent.bridgeId) ??
      get().bridges.find((b) => b.id === "bond");
    const roomNodes = get().nodes[roomId] ?? [];
    const branch = branchToLeaf(roomNodes, mentionNodeId);
    const messages = threadToChatMessages(branch, SYSTEM_PROMPT);

    const author: Identity = { did: agent.did, displayName: agent.displayName, kind: "agent" };
    const lamport = nextLamport(maxLamport(roomNodes));
    const reply = makeNode({
      roomId,
      parentId: mentionNodeId,
      author,
      type: "text",
      payload: { body: "" },
      lamport,
    });
    set((s) => ({
      nodes: { ...s.nodes, [roomId]: [...(s.nodes[roomId] ?? []), reply] },
      streaming: { ...s.streaming, [reply.id]: true },
      monthlyRuns: s.monthlyRuns + 1,
    }));

    const updateBody = (text: string) =>
      set((s) => ({
        nodes: {
          ...s.nodes,
          [roomId]: (s.nodes[roomId] ?? []).map((n) =>
            n.id === reply.id ? { ...n, payload: { body: text } } : n,
          ),
        },
      }));

    // Agent tool activity (balance, USDC transfer, swap, skills) lands as tool_call /
    // tool_result nodes nested under the reply, so the room shows what the agent did.
    const appendToolNode = async <K extends "tool_call" | "tool_result">(
      type: K,
      payload: PayloadMap[K],
    ) => {
      const lam = nextLamport(maxLamport(get().nodes[roomId] ?? []));
      const toolNode = makeNode<K>({ roomId, parentId: reply.id, author, type, payload, lamport: lam });
      await storage.append(toolNode);
      set((s) => ({ nodes: { ...s.nodes, [roomId]: [...(s.nodes[roomId] ?? []), toolNode] } }));
      broadcastNode(roomId, toolNode);
    };

    let text = "";
    if (!bridge || bridge.status === "error") {
      text = "This agent's bridge is not connected. Open Agents to connect one.";
      updateBody(text);
    } else {
      // Per-chunk inactivity timeout. A legitimate turn can run long, so there is no hard
      // total cap: instead the stream is aborted only when it goes silent for too long. The
      // signal is threaded into the adapter, which passes it to fetch, so an abort tears the
      // underlying request down. AbortController + setTimeout is used, not AbortSignal.timeout,
      // which is not guaranteed on React Native / Hermes.
      const controller = new AbortController();
      const INACTIVITY_MS = 60_000;
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      const armInactivity = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, INACTIVITY_MS);
      };
      // Build each installed skill's claim with a fresh wallet-ownership proof. The server
      // verifies the proof against the on-chain payer before unlocking, so a claim that only
      // names the payer (the explorer-read bypass) unlocks nothing. Fails closed to no skills.
      const skillClaims = await buildSkillClaims(get().identity, get().secretKey);
      try {
        armInactivity();
        for await (const ev of bridge.adapter.sendTurn({
          threadId: roomId,
          sessionKey: roomId,
          messages,
          signal: controller.signal,
          skills: skillClaims,
        })) {
          armInactivity(); // every event resets the inactivity window
          if (ev.kind === "text") {
            text += ev.delta;
            updateBody(text);
          } else if (ev.kind === "tool_call") {
            await appendToolNode("tool_call", {
              callId: ev.id,
              name: ev.name,
              arguments: (ev.args ?? {}) as Record<string, unknown>,
            });
          } else if (ev.kind === "tool_result") {
            const content =
              typeof ev.result === "string"
                ? [{ type: "text" as const, text: ev.result }]
                : [{ type: "text" as const, text: JSON.stringify(ev.result) }];
            await appendToolNode("tool_result", { callId: ev.id, content, isError: ev.isError });
          } else if (ev.kind === "error") {
            text += (text ? "\n\n" : "") + `[error] ${ev.message}`;
            updateBody(text);
          }
        }
      } catch (e) {
        // A hung or aborted stream surfaces as an error in the reply. The finally below
        // stops the streaming spinner, so a dead stream never spins forever.
        const reason = timedOut
          ? "the agent stream stalled and was stopped"
          : String((e as Error)?.message ?? e);
        text += (text ? "\n\n" : "") + `[error] ${reason}`;
        updateBody(text);
      } finally {
        if (inactivityTimer) clearTimeout(inactivityTimer);
      }
    }
    const finalReply: BondNode = { ...reply, payload: { body: text } };
    await storage.append(finalReply);
    // Relay the finished reply once, with its complete body. Broadcasting the empty streaming
    // placeholder or each delta would hand a peer an unsigned node whose content then changes
    // under the same id, which the peer's gate rejects as a shadow. One final send avoids that.
    broadcastNode(roomId, finalReply);
    await storage.setItem(KEY_RUNS, get().monthlyRuns);
    set((s) => ({ streaming: { ...s.streaming, [reply.id]: false } }));
  },

  // A human-signed USDC payment posted into a room: the connected wallet signs through MWA
  // and the settled transfer becomes a signed `payment` node. The spend gate runs first, so
  // a transfer over the user's threshold needs biometric or PIN before the wallet is asked.
  // Heavy Solana modules load lazily so this store stays cheap to import under jest and web.
  sendPayment: async (roomId, parentId, toAddress, uiAmount, memo) => {
    const { identity, secretKey, storage } = get();
    if (!identity || !secretKey || !storage) throw new Error("Bond is not ready");

    const { USDC_DEVNET_MINT, USDC_DECIMALS, SOLANA_CLUSTER, getConnection } = await import(
      "../solana/config"
    );
    const { toBaseUnits, fromBaseUnits, buildUsdcTransfer } = await import("../solana/usdc");

    // Parse with the exact decimal parser the transfer uses, so a malformed amount is
    // rejected here and the spend gate sees the real value rather than NaN slipping past the
    // >= threshold check as "below threshold".
    let amountBase: bigint;
    try {
      amountBase = toBaseUnits(uiAmount, USDC_DECIMALS);
    } catch {
      throw new Error(`Invalid payment amount: ${uiAmount}`);
    }
    if (amountBase <= 0n) throw new Error("Payment amount must be greater than zero");
    const amountUsdc = Number(fromBaseUnits(amountBase, USDC_DECIMALS));

    const { requireAuth } = await import("../protection/gate");
    const gate = await requireAuth("spend", { amountUsdc });
    if (!gate.ok) {
      throw new Error(
        gate.outcome === "no_pin"
          ? "Set a PIN in Protection to approve payments"
          : gate.outcome === "locked_out"
            ? "Too many attempts. Try again shortly."
            : "Payment was not authorized",
      );
    }

    const { useWallet } = await import("../solana/store");
    const w = useWallet.getState();
    if (!w.connectedAddress || !w.authToken) {
      throw new Error("Connect a wallet before sending USDC");
    }

    const { signAndSendTransaction } = await import("../solana/wallet");
    const { confirmSignature } = await import("../solana/confirm");
    const { PublicKey } = await import("@solana/web3.js");

    const connection = getConnection();
    const built = await buildUsdcTransfer(
      connection,
      new PublicKey(w.connectedAddress),
      new PublicKey(toAddress),
      uiAmount,
    );
    // A returned signature means the transfer was submitted, not that it landed. Wait for
    // on-chain confirmation before the receipt is ever recorded as "confirmed".
    const signature = await signAndSendTransaction(built.transaction, { authToken: w.authToken });
    await confirmSignature(connection, signature, {
      blockhash: built.transaction.recentBlockhash as string,
      lastValidBlockHeight: built.lastValidBlockHeight,
    });

    const roomNodes = get().nodes[roomId] ?? [];
    const lamport = nextLamport(maxLamport(roomNodes));
    const node = createSignedNode(
      {
        roomId,
        parentId,
        author: identity,
        type: "payment",
        payload: {
          cluster: SOLANA_CLUSTER,
          mint: USDC_DEVNET_MINT,
          asset: "USDC",
          amount: built.amountBaseUnits.toString(),
          decimals: USDC_DECIMALS,
          from: w.connectedAddress,
          to: toAddress,
          signature,
          status: "confirmed",
          memo,
        },
        lamport,
      },
      secretKey,
    );
    await storage.append(node);
    set((s) => ({ nodes: { ...s.nodes, [roomId]: [...(s.nodes[roomId] ?? []), node] } }));
    broadcastNode(roomId, node);
    return node;
  },

  // A read-only mainnet read: the connected wallet's SKR balance and the price of one SKR in
  // USDC. SKR is Seeker's mainnet SPL token and nothing here moves it or signs anything, the
  // same class as the Jupiter quote the Wallet screen shows. The heavy Solana module loads
  // lazily so this store stays cheap to import under jest and web.
  refreshSkr: async (ownerAddress) => {
    set((s) => ({
      skr: {
        balanceUi: s.skr?.balanceUi ?? "0",
        priceInUsdc: s.skr?.priceInUsdc ?? 0,
        isHolder: s.skr?.isHolder ?? false,
        loading: true,
        error: null,
      },
    }));
    try {
      const { readSkrTouchpoint } = await import("../solana/skr");
      const t = await readSkrTouchpoint(ownerAddress);
      set({
        skr: {
          balanceUi: t.skrBalanceUi,
          priceInUsdc: t.skrPriceInUsdc,
          isHolder: t.isHolder,
          loading: false,
          error: null,
        },
      });
    } catch (e) {
      set((s) => ({
        skr: {
          balanceUi: s.skr?.balanceUi ?? "0",
          priceInUsdc: 0,
          isHolder: s.skr?.isHolder ?? false,
          loading: false,
          error: String((e as Error)?.message ?? e),
        },
      }));
    }
  },

  openRoomSync: async (roomId) => {
    if (!roomId) return;
    // Lazy-load the sync module so jest then the web export never pay for it unless a room is
    // actually opened. The client is created only where a WebSocket exists, so the app stays
    // local-first with sync off (jest has no WebSocket, so this returns early there).
    const { isSyncAvailable, createSyncClient } = await import("../sync/client");
    if (!isSyncAvailable()) return;
    if (syncClients.has(roomId)) return;
    const cfg = defaultBondConfig();
    const client = createSyncClient({
      gatewayBaseUrl: cfg.baseUrl,
      token: cfg.apiKey,
      roomId,
      sinceLamport: async () => {
        const storage = get().storage;
        return storage ? storage.maxLamport(roomId) : 0;
      },
      onRemoteNode: async (node) => {
        const storage = get().storage;
        if (!storage) return;
        // Ingest through the Storage port so the verify gate runs: a tampered node is dropped,
        // an unsigned node is kept but never shown as verified. Then re-read the room so the
        // view reflects exactly what the gate accepted, re-verified, never a server assertion.
        await storage.append(node);
        const fresh = await storage.nodesForRoom(roomId);
        set((s) => ({ nodes: { ...s.nodes, [roomId]: fresh } }));
      },
    });
    syncClients.set(roomId, client);
    client.start();
  },

  closeRoomSync: (roomId) => {
    const client = syncClients.get(roomId);
    if (!client) return;
    client.stop();
    syncClients.delete(roomId);
  },
}));
