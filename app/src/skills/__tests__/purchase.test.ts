// The purchase builder and split math are verified through mocked @solana/web3.js,
// @solana/spl-token, the wallet and the protection gate, so the suite never loads a native
// or ESM build and stays green on any platform. The split arithmetic is pure and runs for
// real. What matters for a sale is the shape: one transaction that pays the creator and the
// platform together, in amounts that always sum to exactly the price.
jest.mock("@solana/web3.js", () => {
  class PublicKey {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
    toBase58() {
      return this.value;
    }
    equals(other: PublicKey) {
      return this.value === other.value;
    }
  }
  class Transaction {
    instructions: unknown[] = [];
    feePayer?: unknown;
    recentBlockhash?: string;
    lastValidBlockHeight?: number;
    add(...ixs: unknown[]) {
      this.instructions.push(...ixs);
      return this;
    }
  }
  return { PublicKey, Transaction };
});

jest.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddressSync: jest.fn((mint, owner) => ({ ata: true, mint, owner })),
  createAssociatedTokenAccountIdempotentInstruction: jest.fn((...args) => ({ ix: "createAta", args })),
  createTransferCheckedInstruction: jest.fn((...args) => ({ ix: "transfer", args })),
}));

jest.mock("../../solana/wallet", () => ({
  signAndSendTransaction: jest.fn(async () => "SIG_TEST_SIGNATURE"),
}));

jest.mock("../../protection/gate", () => ({
  requireAuth: jest.fn(),
}));

import { PublicKey } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { signAndSendTransaction } from "../../solana/wallet";
import { requireAuth } from "../../protection/gate";
import {
  buildSkillPurchaseTransaction,
  computeSplit,
  executeSkillPurchase,
  quoteSkillPurchase,
  DEFAULT_PLATFORM_FEE_BPS,
  PLATFORM_WALLET,
} from "../purchase";
import type { Skill } from "../manifest";

const skill: Skill = {
  id: "test-skill",
  name: "Test Skill",
  description: "A skill used only in tests.",
  category: "developer",
  author: { did: "did:key:zTest", wallet: "AUTHOR_WALLET", displayName: "Tester" },
  price: { asset: "USDC", amount: "2.50" },
  distribution: "http",
  endpoint: "https://example.test/skill",
  tools: [{ name: "do_thing" }],
  permissions: ["Does a thing"],
};

describe("computeSplit", () => {
  it("splits at the default 20% fee and conserves the total", () => {
    const split = computeSplit(2_500_000n);
    expect(split.authorAmount).toBe(2_000_000n);
    expect(split.platformAmount).toBe(500_000n);
    expect(split.authorAmount + split.platformAmount).toBe(2_500_000n);
    expect(split.platformFeeBps).toBe(DEFAULT_PLATFORM_FEE_BPS);
  });

  it("floors the author cut so the platform absorbs the dust, never leaking a base unit", () => {
    for (const total of [1n, 3n, 7n, 999n, 1_000_001n, 123_456_789n]) {
      for (const bps of [0, 1, 250, 2000, 3333, 9999, 10000]) {
        const split = computeSplit(total, bps);
        expect(split.authorAmount + split.platformAmount).toBe(total);
        expect(split.authorAmount).toBeGreaterThanOrEqual(0n);
        expect(split.platformAmount).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it("sends everything to the author at a 0% fee and to the platform at 100%", () => {
    expect(computeSplit(1_000_000n, 0)).toMatchObject({ authorAmount: 1_000_000n, platformAmount: 0n });
    expect(computeSplit(1_000_000n, 10000)).toMatchObject({ authorAmount: 0n, platformAmount: 1_000_000n });
  });

  it("rejects an out-of-range or non-integer fee and a negative total", () => {
    expect(() => computeSplit(100n, -1)).toThrow();
    expect(() => computeSplit(100n, 10001)).toThrow();
    expect(() => computeSplit(100n, 12.5)).toThrow();
    expect(() => computeSplit(-1n)).toThrow();
  });
});

describe("quoteSkillPurchase", () => {
  it("prices a skill into base units and a display split, on any platform", () => {
    const quote = quoteSkillPurchase(skill);
    expect(quote.totalBaseUnits).toBe("2500000");
    expect(quote.authorBaseUnits).toBe("2000000");
    expect(quote.platformBaseUnits).toBe("500000");
    expect(quote.totalUi).toBe("2.5");
    expect(quote.authorUi).toBe("2");
    expect(quote.platformUi).toBe("0.5");
    expect(quote.decimals).toBe(6);
    expect(quote.authorWallet).toBe("AUTHOR_WALLET");
    expect(quote.platformWallet).toBe(PLATFORM_WALLET);
  });
});

describe("buildSkillPurchaseTransaction", () => {
  const connection = {
    getLatestBlockhash: jest.fn(async () => ({ blockhash: "HASH", lastValidBlockHeight: 42 })),
  };
  beforeEach(() => jest.clearAllMocks());

  it("builds one atomic transaction that pays the author and the platform", async () => {
    const buyer = new PublicKey("BUYER");
    const built = await buildSkillPurchaseTransaction(connection as never, buyer, skill);

    // two idempotent ATA creates plus two transferChecked, in one transaction
    expect(built.transaction.instructions).toHaveLength(4);
    expect(built.transaction.feePayer).toBe(buyer);
    expect(built.transaction.lastValidBlockHeight).toBe(42);

    // one token account resolved for the buyer, the author and the platform
    expect(getAssociatedTokenAddressSync).toHaveBeenCalledTimes(3);

    const transfers = (createTransferCheckedInstruction as jest.Mock).mock.calls;
    expect(transfers).toHaveLength(2);
    expect(transfers[0][4]).toBe(2_000_000n); // author cut
    expect(transfers[0][5]).toBe(6); // decimals
    expect(transfers[1][4]).toBe(500_000n); // platform remainder
    expect(built.split.authorAmount + built.split.platformAmount).toBe(2_500_000n);
  });

  it("skips a leg with a zero amount so a 0% fee still builds a valid transaction", async () => {
    const buyer = new PublicKey("BUYER");
    const built = await buildSkillPurchaseTransaction(connection as never, buyer, skill, {
      platformFeeBps: 0,
    });
    // author gets everything, no platform transfer, so one ATA create plus one transfer
    expect(built.transaction.instructions).toHaveLength(2);
    expect((createTransferCheckedInstruction as jest.Mock).mock.calls).toHaveLength(1);
    expect(built.split.platformAmount).toBe(0n);
  });

  it("refuses a zero-priced skill", async () => {
    const free: Skill = { ...skill, price: { asset: "USDC", amount: "0" } };
    await expect(
      buildSkillPurchaseTransaction(connection as never, new PublicKey("BUYER"), free),
    ).rejects.toThrow();
  });
});

describe("executeSkillPurchase", () => {
  const connection = {
    getLatestBlockhash: jest.fn(async () => ({ blockhash: "HASH", lastValidBlockHeight: 42 })),
    confirmTransaction: jest.fn(
      async (): Promise<{ value: { err: unknown } }> => ({ value: { err: null } }),
    ),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({
      ok: true,
      outcome: "granted",
      trigger: "spend",
      method: "biometric",
    });
  });

  it("checks the spend gate, signs, confirms and returns the entitlement as proof", async () => {
    const buyer = new PublicKey("BUYER");
    const result = await executeSkillPurchase(connection as never, skill, {
      buyer,
      authToken: "TOKEN",
    });

    expect(requireAuth).toHaveBeenCalledWith("spend", expect.objectContaining({ amountUsdc: 2.5 }));
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
    expect(connection.confirmTransaction).toHaveBeenCalledTimes(1);
    expect(result.signature).toBe("SIG_TEST_SIGNATURE");
    expect(result.entitlement).toMatchObject({
      skillId: "test-skill",
      signature: "SIG_TEST_SIGNATURE",
      buyer: "BUYER",
      amount: "2.50",
      asset: "USDC",
      cluster: "devnet",
    });
    expect(typeof result.entitlement.purchasedAt).toBe("string");
  });

  it("does not sign when the spend gate is not approved", async () => {
    (requireAuth as jest.Mock).mockResolvedValue({
      ok: false,
      outcome: "cancelled",
      trigger: "spend",
      method: "biometric",
    });
    await expect(
      executeSkillPurchase(connection as never, skill, { buyer: new PublicKey("BUYER"), authToken: "TOKEN" }),
    ).rejects.toThrow();
    expect(signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("throws when the payment fails to confirm", async () => {
    connection.confirmTransaction.mockResolvedValueOnce({ value: { err: { InstructionError: [0, "x"] } } });
    await expect(
      executeSkillPurchase(connection as never, skill, { buyer: new PublicKey("BUYER"), authToken: "TOKEN" }),
    ).rejects.toThrow(/confirm/);
  });
});
