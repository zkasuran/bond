// Rendering tests for the in-thread message cards. @expo/vector-icons is stubbed so the
// icon font loader never runs under node; everything else renders for real so the receipt
// card, the tool card and the malformed-node guard are exercised end to end.
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

import TestRenderer from "react-test-renderer";
import { MessageNode } from "../MessageNode";
import type { RenderRow } from "@/model/thread";
import type { BondNode } from "@/model/node";

function renderNode(node: BondNode): string {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  TestRenderer.act(() => {
    tree = TestRenderer.create(
      <MessageNode
        row={{ node, depth: 0, hiddenCount: 0 } as RenderRow}
        streaming={false}
        onReply={() => {}}
        onToggleCollapse={() => {}}
      />,
    );
  });
  return JSON.stringify(tree!.toJSON());
}

const base = {
  id: "01",
  roomId: "r",
  parentId: null,
  lamport: 1,
  createdAt: new Date(0).toISOString(),
  author: { did: "did:key:zAlice", displayName: "Alice", kind: "human" as const },
};

describe("MessageNode payment receipt", () => {
  it("renders a confirmed payment as a receipt card with amount, network and explorer link", () => {
    const node = {
      ...base,
      type: "payment",
      payload: {
        cluster: "devnet",
        mint: "M",
        asset: "USDC",
        amount: "2500000",
        decimals: 6,
        from: "FROMaddressAAAAAAAAAA",
        to: "TOaddressBBBBBBBBBB",
        signature: "SigABC123",
        status: "confirmed",
      },
    } as BondNode;
    const out = renderNode(node);
    expect(out).toContain("2.5");
    expect(out).toContain("USDC");
    expect(out).toContain("devnet");
    expect(out).toContain("Confirmed");
    expect(out).toContain("Solana Explorer");
    expect(out).toMatch(/no real funds/i);
  });

  it("does not throw on a payment node with no payload", () => {
    const node = { ...base, type: "payment", payload: undefined } as unknown as BondNode;
    expect(() => renderNode(node)).not.toThrow();
    expect(renderNode(node)).toContain("[payment]");
  });
});

describe("MessageNode tool card", () => {
  it("renders a tool_call as a tool card with the name and the agent-reported disclaimer", () => {
    const node = {
      ...base,
      author: { did: "did:bond:assistant", displayName: "Bond", kind: "agent" as const },
      type: "tool_call",
      payload: { callId: "c1", name: "get_balance", arguments: { owner: "x" } },
    } as BondNode;
    const out = renderNode(node);
    expect(out).toContain("get_balance");
    expect(out).toContain("called");
    expect(out).toMatch(/not a signed/i);
  });
});

describe("MessageNode malformed guard", () => {
  it("renders a node with no author without throwing", () => {
    const node = {
      id: "02",
      roomId: "r",
      parentId: null,
      lamport: 1,
      createdAt: new Date(0).toISOString(),
      type: "text",
      payload: { body: "hello" },
    } as unknown as BondNode;
    expect(() => renderNode(node)).not.toThrow();
    const out = renderNode(node);
    expect(out).toContain("Unknown");
    expect(out).toContain("hello");
  });
});
