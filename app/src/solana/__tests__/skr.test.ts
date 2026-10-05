// The SKR touchpoint is read-only, so it is verified the same way the USDC and swap readers
// are: @solana/web3.js and @solana/spl-token are mocked so no native build loads. The price
// quote is a mocked fetch. What matters is the shape: a missing SKR account reads as a zero
// balance (not an error), a real account parses, the price inverts a live USDC to SKR quote.
// The holder discount is gated on holding SKR and bounded by a hard ceiling.
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
  class Connection {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
  }
  class Transaction {}
  return { PublicKey, Connection, Transaction, VersionedTransaction: { deserialize: jest.fn() } };
});

jest.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddressSync: jest.fn((mint, owner) => ({ ata: true, mint, owner })),
  createAssociatedTokenAccountIdempotentInstruction: jest.fn(),
  createTransferCheckedInstruction: jest.fn(),
  getAccount: jest.fn(),
}));

import { getAccount } from "@solana/spl-token";
import {
  applySkrHolderDiscount,
  MAX_SKR_HOLDER_DISCOUNT_BPS,
  readSkrTouchpoint,
  skrHolderDiscountBps,
} from "../skr";

// A live USDC to SKR quote: 1 USDC in, 20 SKR out, so one SKR is worth 0.05 USDC.
const skrQuote = {
  inAmount: "1000000",
  outAmount: "20000000",
  otherAmountThreshold: "19900000",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0",
  routePlan: [],
};

function mockQuoteFetch(): void {
  (global as { fetch?: unknown }).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => skrQuote,
  }));
}

beforeEach(() => {
  (getAccount as jest.Mock).mockReset();
  mockQuoteFetch();
});

afterEach(() => {
  (global as { fetch?: unknown }).fetch = undefined;
});

describe("readSkrTouchpoint balance", () => {
  it("returns 0 for a wallet with no SKR account", async () => {
    (getAccount as jest.Mock).mockRejectedValueOnce(new Error("account does not exist"));
    const t = await readSkrTouchpoint("OWNERaddress1111");
    expect(t.skrBalanceUi).toBe("0");
    expect(t.isHolder).toBe(false);
  });

  it("parses a real SKR balance and flags the holder, with a live price", async () => {
    (getAccount as jest.Mock).mockResolvedValueOnce({ amount: 1234567n });
    const t = await readSkrTouchpoint("OWNERaddress1111");
    expect(t.skrBalanceUi).toBe("1.234567");
    expect(t.isHolder).toBe(true);
    expect(t.skrPriceInUsdc).toBeCloseTo(0.05, 6);
  });

  it("reads no balance and never holds when no wallet is connected", async () => {
    const t = await readSkrTouchpoint(null);
    expect(t.skrBalanceUi).toBe("0");
    expect(t.isHolder).toBe(false);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it("returns a 0 price when the quote feed is unavailable, keeping the balance", async () => {
    (getAccount as jest.Mock).mockResolvedValueOnce({ amount: 5000000n });
    (global as { fetch?: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "unavailable",
    }));
    const t = await readSkrTouchpoint("OWNERaddress1111");
    expect(t.skrBalanceUi).toBe("5");
    expect(t.isHolder).toBe(true);
    expect(t.skrPriceInUsdc).toBe(0);
  });
});

describe("skr holder discount", () => {
  it("gives a non-holder no discount", () => {
    const d = applySkrHolderDiscount("2.00", false, 1500);
    expect(d.bps).toBe(0);
    expect(d.savingUi).toBe("0");
    expect(d.discountedUi).toBe("2");
  });

  it("gives a holder the creator-set discount within the ceiling", () => {
    const d = applySkrHolderDiscount("2.00", true, 1500);
    expect(d.bps).toBe(1500);
    expect(d.savingUi).toBe("0.3");
    expect(d.discountedUi).toBe("1.7");
  });

  it("clamps a holder discount to the bounded ceiling", () => {
    const d = applySkrHolderDiscount("2.00", true, 999999);
    expect(d.bps).toBe(MAX_SKR_HOLDER_DISCOUNT_BPS);
    expect(d.bps).toBe(2500);
    expect(d.discountedUi).toBe("1.5");
  });

  it("gates the bps on holding SKR and clamps the creator request", () => {
    expect(skrHolderDiscountBps(false, 2000)).toBe(0);
    expect(skrHolderDiscountBps(true, 2000)).toBe(2000);
    expect(skrHolderDiscountBps(true, 100000)).toBe(2500);
    expect(skrHolderDiscountBps(true)).toBe(1000);
  });
});
