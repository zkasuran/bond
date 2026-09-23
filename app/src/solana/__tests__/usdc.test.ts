// The transfer builder is verified through mocked @solana/web3.js and @solana/spl-token, so
// the suite never loads their native/ESM builds and stays green on any platform. The base
// unit helpers are pure, so they run against real arithmetic. What matters for a payment is
// the shape: an idempotent recipient-account create, then a transferChecked carrying the
// amount in base units and the mint's decimals, with the sender as fee payer.
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
    constructor(opts?: { feePayer?: unknown; blockhash?: string; lastValidBlockHeight?: number }) {
      this.feePayer = opts?.feePayer;
      this.recentBlockhash = opts?.blockhash;
      this.lastValidBlockHeight = opts?.lastValidBlockHeight;
    }
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
  getAccount: jest.fn(),
}));

import { PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { buildUsdcTransfer, fromBaseUnits, toBaseUnits } from "../usdc";

describe("base unit helpers", () => {
  it("converts a decimal ui amount to integer base units at 6 decimals", () => {
    expect(toBaseUnits("12.5")).toBe(12500000n);
    expect(toBaseUnits(1)).toBe(1000000n);
    expect(toBaseUnits("0.000001")).toBe(1n);
    expect(toBaseUnits("0")).toBe(0n);
    expect(toBaseUnits(".5")).toBe(500000n);
  });

  it("rejects junk and more decimals than the mint allows", () => {
    expect(() => toBaseUnits("1.2345678")).toThrow();
    expect(() => toBaseUnits("abc")).toThrow();
    expect(() => toBaseUnits("")).toThrow();
    expect(() => toBaseUnits("1e-6")).toThrow();
  });

  it("round-trips base units back to a trimmed decimal string", () => {
    expect(fromBaseUnits(12500000n)).toBe("12.5");
    expect(fromBaseUnits(1000000n)).toBe("1");
    expect(fromBaseUnits(1n)).toBe("0.000001");
    expect(fromBaseUnits(0n)).toBe("0");
  });
});

describe("buildUsdcTransfer", () => {
  const connection = {
    getLatestBlockhash: jest.fn(async () => ({ blockhash: "HASH", lastValidBlockHeight: 123 })),
  };
  beforeEach(() => jest.clearAllMocks());

  it("builds an idempotent-ATA plus transferChecked transaction in base units", async () => {
    const from = new PublicKey("FROM");
    const to = new PublicKey("TO");
    const result = await buildUsdcTransfer(connection as never, from, to, "2.5");

    expect(result.amountBaseUnits).toBe(2500000n);
    expect(result.uiAmount).toBe("2.5");
    expect(result.decimals).toBe(6);

    expect(createAssociatedTokenAccountIdempotentInstruction).toHaveBeenCalledTimes(1);
    const ataArgs = (createAssociatedTokenAccountIdempotentInstruction as jest.Mock).mock.calls[0];
    expect(ataArgs[0]).toBe(from);
    expect(ataArgs[2]).toBe(to);

    expect(createTransferCheckedInstruction).toHaveBeenCalledTimes(1);
    const transferArgs = (createTransferCheckedInstruction as jest.Mock).mock.calls[0];
    expect(transferArgs[3]).toBe(from);
    expect(transferArgs[4]).toBe(2500000n);
    expect(transferArgs[5]).toBe(6);

    expect(getAssociatedTokenAddressSync).toHaveBeenCalledTimes(2);
    expect(result.transaction.instructions).toHaveLength(2);
    expect(result.transaction.feePayer).toBe(from);
    expect(result.transaction.lastValidBlockHeight).toBe(123);
  });

  it("rejects a zero amount", async () => {
    await expect(
      buildUsdcTransfer(connection as never, new PublicKey("FROM"), new PublicKey("TO"), "0"),
    ).rejects.toThrow();
  });
});
