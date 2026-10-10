import {
  formatBaseUnits,
  lastPaymentCounterparty,
  MAX_TOOL_TEXT_CHARS,
  paymentView,
  shortMiddle,
  toolCallView,
  toolResultView,
} from "../receipt";
import type { PaymentPayload } from "@/model/messages";
import type { BondNode } from "@/model/node";

function payment(over: Partial<PaymentPayload> = {}): PaymentPayload {
  return {
    cluster: "devnet",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    asset: "USDC",
    amount: "2500000",
    decimals: 6,
    from: "FROMwalletADDRESSaaaaaaaaaaaaaaaaaaaaaaaaa",
    to: "TOwalletADDRESSbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    status: "confirmed",
    ...over,
  };
}

describe("formatBaseUnits", () => {
  it("formats base units with decimals and no float rounding", () => {
    expect(formatBaseUnits("2500000", 6)).toBe("2.5");
    expect(formatBaseUnits("1000000", 6)).toBe("1");
    expect(formatBaseUnits("1", 6)).toBe("0.000001");
    expect(formatBaseUnits("0", 6)).toBe("0");
  });
  it("returns 0 for a malformed amount rather than NaN", () => {
    expect(formatBaseUnits("abc", 6)).toBe("0");
    expect(formatBaseUnits("", 6)).toBe("0");
  });
});

describe("shortMiddle", () => {
  it("keeps both ends of a long value and leaves a short one alone", () => {
    expect(shortMiddle("ABCDEFGHIJKL")).toBe("ABCD…IJKL");
    expect(shortMiddle("ABC")).toBe("ABC");
    expect(shortMiddle("")).toBe("");
  });
});

describe("paymentView", () => {
  it("marks a confirmed receipt only after a local on-chain re-check", () => {
    const v = paymentView(payment({ signature: "SigABC123", memo: "lunch" }), "verified");
    expect(v.amountDisplay).toBe("2.5");
    expect(v.asset).toBe("USDC");
    expect(v.networkLabel).toBe("devnet");
    expect(v.statusLabel).toBe("Confirmed on-chain");
    expect(v.statusTone).toBe("verified");
    expect(v.confirmed).toBe(true);
    expect(v.claimDisclaimer).toBeUndefined();
    expect(v.memo).toBe("lunch");
    expect(v.explorerUrl).toContain("https://explorer.solana.com/tx/SigABC123");
    expect(v.explorerUrl).toContain("cluster=devnet");
    expect(v.honesty).toMatch(/no real funds/i);
  });

  it("treats a peer-reported confirmed payment as an unverified claim, not a settlement (F16 HIGH)", () => {
    const v = paymentView(payment({ status: "confirmed", signature: "SigABC123" }));
    expect(v.claimedStatus).toBe("confirmed");
    expect(v.confirmed).toBe(false);
    expect(v.statusTone).not.toBe("verified");
    expect(v.statusLabel).toBe("Claimed");
    expect(v.claimDisclaimer).toMatch(/not re-checked on-chain/i);
  });

  it("has no explorer link until a signature exists and marks a pending transfer", () => {
    const v = paymentView(payment({ status: "pending", signature: undefined }));
    expect(v.explorerUrl).toBeUndefined();
    expect(v.statusLabel).toBe("Pending");
    expect(v.statusTone).toBe("warning");
    expect(v.confirmed).toBe(false);
  });

  it("tolerates a malformed payload without throwing", () => {
    const v = paymentView({ ...payment(), amount: "oops", status: "weird" } as unknown as PaymentPayload);
    expect(v.amountDisplay).toBe("0");
    expect(v.statusLabel).toBe("Proposed");
    expect(v.confirmed).toBe(false);
  });
});

describe("paymentView network and honesty gating (V2 bypass 1)", () => {
  it("never prints an on-chain settlement line for an unverified mainnet claim", () => {
    const v = paymentView(payment({ cluster: "mainnet-beta", status: "confirmed", signature: "S" }));
    expect(v.confirmed).toBe(false);
    expect(v.honesty).not.toBe("On-chain transfer.");
    expect(v.honesty).not.toMatch(/on-chain transfer/i);
    // The network chip must read as unverified, never a confident "mainnet".
    expect(v.networkChip).toMatch(/unverified/i);
    expect(v.networkChip).not.toBe("mainnet");
  });

  it("prints the on-chain settlement line only after a local re-check", () => {
    const v = paymentView(payment({ cluster: "mainnet-beta", status: "confirmed", signature: "S" }), "verified");
    expect(v.confirmed).toBe(true);
    expect(v.honesty).toBe("On-chain transfer.");
    expect(v.networkChip).toBe("mainnet");
  });

  it("does not echo an unknown cluster as a real network", () => {
    const v = paymentView(
      payment({ cluster: "evil-net" as PaymentPayload["cluster"], status: "confirmed", signature: "S" }),
    );
    expect(v.networkLabel).toBe("unknown network");
    expect(v.networkChip).not.toContain("evil-net");
    expect(v.honesty).not.toMatch(/on-chain transfer/i);
  });

  it("keeps a verified devnet transfer labelled as no real funds", () => {
    const v = paymentView(payment({ cluster: "devnet", signature: "S" }), "verified");
    expect(v.networkChip).toBe("devnet");
    expect(v.honesty).toMatch(/no real funds/i);
  });
});

describe("tool views", () => {
  it("renders a tool call with pretty args and the agent-reported disclaimer", () => {
    const v = toolCallView({ callId: "c1", name: "get_balance", arguments: { owner: "x" } });
    expect(v.name).toBe("get_balance");
    expect(v.argsText).toContain("owner");
    expect(v.disclaimer).toMatch(/not a signed/i);
  });
  it("flattens tool result content and flags an error result", () => {
    const ok = toolResultView({ callId: "c1", content: [{ type: "text", text: "1.5 USDC" }] });
    expect(ok.resultText).toBe("1.5 USDC");
    expect(ok.isError).toBe(false);
    const bad = toolResultView({ callId: "c2", content: [], isError: true });
    expect(bad.isError).toBe(true);
    expect(bad.resultText).toBe("tool error");
  });

  it("bounds a giant tool-call args string so one node cannot blow up the card (F16 LOW)", () => {
    const v = toolCallView({ callId: "c1", name: "big", arguments: { blob: "x".repeat(50000) } });
    expect(v.argsText!.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS + 1);
  });
});

describe("lastPaymentCounterparty", () => {
  function node(p: PaymentPayload): BondNode {
    return {
      id: Math.random().toString(36).slice(2),
      roomId: "r",
      parentId: null,
      lamport: 1,
      createdAt: new Date(0).toISOString(),
      author: { did: "d", displayName: "n", kind: "human" },
      type: "payment",
      payload: p,
    } as BondNode;
  }
  it("returns the party that is not us from the most recent payment", () => {
    const self = "SELFaddr";
    const nodes = [
      node(payment({ from: self, to: "PEER1" })),
      node(payment({ from: "PEER2", to: self })),
    ];
    expect(lastPaymentCounterparty(nodes, self)).toBe("PEER2");
  });
  it("is empty when the room has no payment", () => {
    const textNode = { ...node(payment()), type: "text", payload: { body: "hi" } } as BondNode;
    expect(lastPaymentCounterparty([textNode], "SELF")).toBe("");
  });
});
