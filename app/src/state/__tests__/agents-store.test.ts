// The agent directory in the store: create an agent with a @handle and persona, bring it into a
// second room by @handle (same did and persona, per-room job), and address agents by typing.
jest.mock("../../skills/registry", () => ({ useSkills: { getState: () => ({ load: async () => {}, entitlements: {} }) } }));
jest.mock("../../solana/store", () => ({ useWallet: { getState: () => ({ loadStoredBinding: async () => {} }) } }));

import { useBond, type Bridge } from "../store";
import { generateKeypair } from "../../identity/keys";
import type { BondNode } from "../../model/node";
import type { SendTurnInput } from "../../bridge/adapter";

const turns: SendTurnInput[] = [];
const bridge: Bridge = {
  id: "bond",
  kind: "bond",
  displayName: "Bond gateway",
  config: { baseUrl: "https://x/v1" },
  status: "connected",
  adapter: {
    async *sendTurn(input: SendTurnInput) {
      turns.push(input);
      yield { kind: "text", delta: "ok" } as never;
      yield { kind: "done" } as never;
    },
  } as never,
};

const kv = new Map<string, unknown>();
const log: BondNode[] = [];
const storage = {
  append: async (n: BondNode) => void log.push(n),
  appendMany: async () => {},
  nodesForRoom: async () => [],
  maxLamport: async () => 0,
  roomIds: async () => [],
  getItem: async (k: string) => kv.get(k) ?? null,
  setItem: async (k: string, v: unknown) => void kv.set(k, v),
};

beforeEach(() => {
  turns.length = 0;
  const kp = generateKeypair();
  useBond.setState({
    ready: true,
    identity: { did: kp.did, displayName: "You", kind: "human" },
    secretKey: kp.secretKey,
    storage: storage as never,
    rooms: [],
    members: {},
    nodes: {},
    bridges: [bridge],
    agents: {},
    streaming: {},
  });
});

async function twoRooms() {
  const a = await useBond.getState().createRoom("A");
  const b = await useBond.getState().createRoom("B");
  return [a.id, b.id] as const;
}

it("creates an agent with a handle and persona and saves the directory", async () => {
  const [a] = await twoRooms();
  const mem = await useBond.getState().createAgent(a, bridge, {
    displayName: "Scout",
    handle: "@Scout",
    persona: "terse pirate",
    job: "watch SOL",
  });
  expect(mem).toMatchObject({ did: "did:bond:agent:@scout", handle: "scout", job: "watch SOL" });
  expect(useBond.getState().agents[mem.did]).toMatchObject({ handle: "scout", persona: "terse pirate" });
  expect((kv.get("bond.agents") as Record<string, unknown>)[mem.did]).toBeTruthy();
});

it("rejects a taken or invalid handle", async () => {
  const [a] = await twoRooms();
  await useBond.getState().createAgent(a, bridge, { displayName: "Scout", handle: "scout" });
  await expect(useBond.getState().createAgent(a, bridge, { displayName: "S2", handle: "scout" })).rejects.toThrow(/already/);
  await expect(useBond.getState().createAgent(a, bridge, { displayName: "S3", handle: "1x" })).rejects.toThrow(/letters/);
});

it("imports the same agent into another room by handle, keeping did and persona, with its own job", async () => {
  const [a, b] = await twoRooms();
  const made = await useBond.getState().createAgent(a, bridge, { displayName: "Scout", handle: "scout", persona: "terse", job: "room A job" });
  const imported = await useBond.getState().importAgent(b, "@scout", "room B job");
  expect(imported.did).toBe(made.did);
  expect(imported.job).toBe("room B job");
  await expect(useBond.getState().importAgent(b, "scout")).rejects.toThrow(/already in this room/);
  await expect(useBond.getState().importAgent(b, "ghost")).rejects.toThrow(/no agent called @ghost/);
  // A persona change applies everywhere.
  await useBond.getState().updateAgentPersona(made.did, "chatty");
  await useBond.getState().postText(b, null, "@scout hi");
  expect(turns.at(-1)).toMatchObject({ persona: "chatty", job: "room B job", agentHandle: "scout" });
});

it("only the agents addressed by typing reply, and the mention is signed into the node", async () => {
  const [a] = await twoRooms();
  await useBond.getState().createAgent(a, bridge, { displayName: "Scout", handle: "scout" });
  const node = await useBond.getState().postText(a, null, "@scout what do you see?");
  expect(turns.map((t) => t.agentHandle)).toEqual(["scout"]);
  expect((node.payload as { mentions?: string[] }).mentions).toEqual(["did:bond:agent:@scout"]);
  turns.length = 0;
  await useBond.getState().postText(a, null, "@bond and @scout, both of you");
  expect(turns.map((t) => t.agentHandle).sort()).toEqual(["bond", "scout"]);
  turns.length = 0;
  await useBond.getState().postText(a, null, "no one is addressed");
  expect(turns).toHaveLength(0);
});
