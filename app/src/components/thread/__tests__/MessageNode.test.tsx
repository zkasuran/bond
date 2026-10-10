// Rendering tests for the in-thread message cards. @expo/vector-icons is stubbed so the
// icon font loader never runs under node; everything else renders for real so the receipt
// card, the tool card and the malformed-node guard are exercised end to end.
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

import TestRenderer from "react-test-renderer";
import { MessageNode } from "../MessageNode";
import { PaySheet } from "../PaySheet";
import { shortMiddle } from "../receipt";
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
  it("renders a peer-reported confirmed payment as an unverified claim, not a settlement (F16 HIGH)", () => {
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
    expect(out).toContain("Claimed");
    expect(out).toContain("Solana Explorer");
    expect(out).toMatch(/not re-checked on-chain/i);
    expect(out).toMatch(/no real funds/i);
    // The attacker-set status must not surface as a green on-chain confirmation.
    expect(out).not.toContain("Confirmed");
  });

  it("does not throw on a payment node with no payload", () => {
    const node = { ...base, type: "payment", payload: undefined } as unknown as BondNode;
    expect(() => renderNode(node)).not.toThrow();
    expect(renderNode(node)).toContain("[payment]");
  });

  it("does not render an on-chain settlement line for a peer-set mainnet cluster (V2 bypass 1)", () => {
    const node = {
      ...base,
      type: "payment",
      payload: {
        cluster: "mainnet-beta",
        mint: "M",
        asset: "USDC",
        amount: "500000000",
        decimals: 6,
        from: "FROMaddressAAAAAAAAAA",
        to: "TOaddressBBBBBBBBBB",
        signature: "SigZ999",
        status: "confirmed",
      },
    } as BondNode;
    const out = renderNode(node);
    // A peer who signs a mainnet-beta payment node must not make the card assert settlement.
    expect(out).not.toContain("On-chain transfer.");
    expect(out).toMatch(/unverified/i);
    expect(out).toMatch(/not re-checked on-chain/i);
    expect(out).not.toContain("Confirmed on-chain");
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

describe("PaySheet recipient suggestion (F16 MED)", () => {
  const attacker = "ATTACKERwalletADDRESSxxxxxxxxxxxxxxxxxxxxxx";

  function mountPaySheet() {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    TestRenderer.act(() => {
      tree = TestRenderer.create(
        <PaySheet
          visible
          defaultRecipient={attacker}
          selfAddress="SELFwalletADDRESS"
          onSubmit={async () => {}}
          onClose={() => {}}
        />,
      );
    });
    return tree!;
  }

  it("does not silently pre-fill the recipient from an untrusted payment node", () => {
    const tree = mountPaySheet();
    // The full untrusted address must never land in the send-to field as a trusted default.
    expect(JSON.stringify(tree.toJSON())).not.toContain(attacker);
    const inputs = tree.root
      .findAll((n) => n.props?.testID === "pay-recipient-input")
      .filter((n) => typeof n.props.value === "string");
    expect(inputs.length).toBeGreaterThan(0);
    for (const i of inputs) expect(i.props.value).toBe("");
  });

  it("offers the learned address as a suggestion the user must tap", () => {
    const tree = mountPaySheet();
    const suggestion = tree.root.findAll((n) => n.props?.testID === "pay-recipient-suggestion");
    expect(suggestion.length).toBeGreaterThan(0);
    expect(JSON.stringify(tree.toJSON())).toContain(shortMiddle(attacker));
  });
});
