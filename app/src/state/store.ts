// The Bond app engine: a zustand store tying identity, the append-only log, the agent
// bridges and thread routing together. Local-first: a node is written and shown
// immediately, agents stream their replies in-thread. See DESIGN.md sec 6 and 9.
import { create } from "zustand";
import { ulid } from "ulidx";
import type { BondNode, Identity } from "../model/node";
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

    let text = "";
    if (!bridge || bridge.status === "error") {
      text = "This agent's bridge is not connected. Open Agents to connect one.";
      updateBody(text);
    } else {
      try {
        for await (const ev of bridge.adapter.sendTurn({
          threadId: roomId,
          sessionKey: roomId,
          messages,
        })) {
          if (ev.kind === "text") {
            text += ev.delta;
            updateBody(text);
          } else if (ev.kind === "error") {
            text += (text ? "\n\n" : "") + `[error] ${ev.message}`;
            updateBody(text);
          }
        }
      } catch (e) {
        text += (text ? "\n\n" : "") + `[error] ${String((e as Error)?.message ?? e)}`;
        updateBody(text);
      }
    }
    const finalReply: BondNode = { ...reply, payload: { body: text } };
    await storage.append(finalReply);
    await storage.setItem(KEY_RUNS, get().monthlyRuns);
    set((s) => ({ streaming: { ...s.streaming, [reply.id]: false } }));
  },
}));
