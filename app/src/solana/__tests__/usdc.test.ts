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
import { confirmSignature, PaymentMismatchError, TransferFailedError } from "../confirm";

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

describe("toBaseUnits bounds (F10)", () => {
  it("rejects an amount whose base units exceed the u64 ceiling", () => {
    expect(() => toBaseUnits("99999999999999999999")).toThrow();
  });

  it("rejects an over-long amount string before it reaches BigInt", () => {
    expect(() => toBaseUnits("1".repeat(100))).toThrow();
  });

  it("rejects NaN, Infinity and negative numbers", () => {
    expect(() => toBaseUnits(Number.NaN)).toThrow();
    expect(() => toBaseUnits(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => toBaseUnits(-5)).toThrow();
  });
});

describe("confirmSignature (F10)", () => {
  const ctx = { blockhash: "HASH", lastValidBlockHeight: 123 };
  const fast = { maxAttempts: 1 as const, timeoutMs: 1000, retryDelayMs: 0 };

  it("resolves the signature only on an explicit null error", async () => {
    const connection = { confirmTransaction: jest.fn(async () => ({ value: { err: null } })) };
    await expect(confirmSignature(connection as never, "SIG", ctx, "confirmed", fast)).resolves.toBe("SIG");
  });

  it("throws a TransferFailedError when the cluster reports an execution error", async () => {
    const connection = {
      confirmTransaction: jest.fn(async () => ({ value: { err: { InstructionError: [0, "Custom"] } } })),
    };
    await expect(confirmSignature(connection as never, "SIG", ctx, "confirmed", fast)).rejects.toBeInstanceOf(
      TransferFailedError,
    );
  });

  it("does not read a malformed empty response as confirmed", async () => {
    const connection = { confirmTransaction: jest.fn(async () => ({})) };
    await expect(confirmSignature(connection as never, "SIG", ctx, "confirmed", fast)).rejects.toThrow();
  });

  it("does not read a null-value response as confirmed", async () => {
    const connection = { confirmTransaction: jest.fn(async () => ({ value: null })) };
    await expect(confirmSignature(connection as never, "SIG", ctx, "confirmed", fast)).rejects.toThrow();
  });

  it("rejects within the wall-clock timeout instead of hanging on a stalled RPC", async () => {
    const connection = { confirmTransaction: jest.fn(() => new Promise(() => {})) };
    await expect(
      confirmSignature(connection as never, "SIG", ctx, "confirmed", { maxAttempts: 1, timeoutMs: 50, retryDelayMs: 0 }),
    ).rejects.toThrow(/timed out/i);
  });

  it("retries a transient RPC error up to the attempt bound", async () => {
    const confirmTransaction = jest
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ value: { err: null } });
    const connection = { confirmTransaction };
    await expect(
      confirmSignature(connection as never, "SIG", ctx, "confirmed", { maxAttempts: 2, timeoutMs: 1000, retryDelayMs: 1 }),
    ).resolves.toBe("SIG");
    expect(confirmTransaction).toHaveBeenCalledTimes(2);
  });
});

describe("confirmSignature transfer binding (V2 bypass 2)", () => {
  const ctx = { blockhash: "HASH", lastValidBlockHeight: 123 };
  const fast = { maxAttempts: 1 as const, timeoutMs: 1000, retryDelayMs: 0 };
  const expected = { amount: "2500000", mint: "MINT", from: "ALICE", to: "BOB" };

  function parsedTransfer(from: string, to: string, sent: string, received: string) {
    return {
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 0, mint: "MINT", owner: from, uiTokenAmount: { amount: "10000000" } },
          { accountIndex: 1, mint: "MINT", owner: to, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 0, mint: "MINT", owner: from, uiTokenAmount: { amount: String(10000000n - BigInt(sent)) } },
          { accountIndex: 1, mint: "MINT", owner: to, uiTokenAmount: { amount: received } },
        ],
      },
    };
  }

  it("confirms when the fetched transfer matches the expected amount, mint, sender and recipient", async () => {
    const connection = {
      confirmTransaction: jest.fn(async () => ({ value: { err: null } })),
      getParsedTransaction: jest.fn(async () => parsedTransfer("ALICE", "BOB", "2500000", "2500000")),
    };
    await expect(
      confirmSignature(connection as never, "SIG", ctx, "confirmed", { ...fast, expected }),
    ).resolves.toBe("SIG");
    expect(connection.getParsedTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects a confirmed signature pointed at a transfer with the wrong amount", async () => {
    // The real on-chain transfer moved 0.01 USDC, the receipt claims 2.5.
    const connection = {
      confirmTransaction: jest.fn(async () => ({ value: { err: null } })),
      getParsedTransaction: jest.fn(async () => parsedTransfer("ALICE", "BOB", "10000", "10000")),
    };
    await expect(
      confirmSignature(connection as never, "SIG", ctx, "confirmed", { ...fast, expected }),
    ).rejects.toBeInstanceOf(PaymentMismatchError);
  });

  it("rejects a confirmed signature whose recipient is not the expected recipient", async () => {
    const connection = {
      confirmTransaction: jest.fn(async () => ({ value: { err: null } })),
      getParsedTransaction: jest.fn(async () => parsedTransfer("ALICE", "MALLORY", "2500000", "2500000")),
    };
    await expect(
      confirmSignature(connection as never, "SIG", ctx, "confirmed", { ...fast, expected }),
    ).rejects.toBeInstanceOf(PaymentMismatchError);
  });

  it("fails closed when the transaction cannot be fetched to verify the transfer", async () => {
    const connection = {
      confirmTransaction: jest.fn(async () => ({ value: { err: null } })),
      getParsedTransaction: jest.fn(async () => null),
    };
    await expect(
      confirmSignature(connection as never, "SIG", ctx, "confirmed", { ...fast, expected }),
    ).rejects.toThrow();
  });

  it("still confirms a bare signature for execution only when no expectations are supplied", async () => {
    const connection = {
      confirmTransaction: jest.fn(async () => ({ value: { err: null } })),
      getParsedTransaction: jest.fn(),
    };
    await expect(confirmSignature(connection as never, "SIG", ctx, "confirmed", fast)).resolves.toBe("SIG");
    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
  });
});
