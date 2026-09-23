// Swap quote parsing and the two Jupiter calls, verified with a mocked fetch and mocked
// solana libraries so nothing hits the network or loads a native build. The fixture is the
// real shape of a lite-api quote (SOL to USDC) captured from the live endpoint, so the parse
// test tracks the actual field names the /swap endpoint needs back.
jest.mock("@solana/web3.js", () => ({
  VersionedTransaction: { deserialize: jest.fn(() => ({ versioned: true })) },
}));
jest.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddressSync: jest.fn(),
  createAssociatedTokenAccountIdempotentInstruction: jest.fn(),
  createTransferCheckedInstruction: jest.fn(),
  getAccount: jest.fn(),
}));

import { getQuote, getSwapTransaction, summarizeQuote, type JupiterQuote } from "../swap";

const sampleQuote: JupiterQuote = {
  inputMint: "So11111111111111111111111111111111111111112",
  inAmount: "100000000",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  outAmount: "11432381",
  otherAmountThreshold: "11375220",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0.00008",
  routePlan: [
    {
      swapInfo: {
        ammKey: "amm1",
        label: "GoonFi V2",
        inputMint: "a",
        outputMint: "b",
        inAmount: "1",
        outAmount: "2",
      },
      percent: 100,
    },
  ],
  contextSlot: 449763900,
};

afterEach(() => {
  jest.restoreAllMocks();
  (global as { fetch?: unknown }).fetch = undefined;
});

describe("summarizeQuote", () => {
  it("converts base units to ui amounts with each token's decimals", () => {
    const summary = summarizeQuote(sampleQuote, 9, 6);
    expect(summary.inUiAmount).toBe("0.1");
    expect(summary.outUiAmount).toBe("11.432381");
    expect(summary.minReceivedUiAmount).toBe("11.37522");
    expect(summary.slippageBps).toBe(50);
    expect(summary.route).toEqual(["GoonFi V2"]);
    expect(summary.rate).toBeCloseTo(114.32381, 4);
  });
});

describe("getQuote", () => {
  it("builds the query and returns the parsed quote", async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => sampleQuote }));
    (global as { fetch?: unknown }).fetch = fetchMock;

    const quote = await getQuote({ inputMint: "IN", outputMint: "OUT", amount: 5000 });
    const url = (fetchMock.mock.calls as unknown[][])[0][0] as string;
    expect(url).toContain("/quote?");
    expect(url).toContain("inputMint=IN");
    expect(url).toContain("outputMint=OUT");
    expect(url).toContain("amount=5000");
    expect(url).toContain("slippageBps=50");
    expect(quote.outAmount).toBe("11432381");
  });

  it("throws with the status on a non-2xx", async () => {
    (global as { fetch?: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));
    await expect(getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 })).rejects.toThrow(/429/);
  });
});

describe("getSwapTransaction", () => {
  it("posts the quote and user pubkey and returns the base64 transaction", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        swapTransaction: "BASE64TX",
        lastValidBlockHeight: 100,
        prioritizationFeeLamports: 5000,
      }),
    }));
    (global as { fetch?: unknown }).fetch = fetchMock;

    const result = await getSwapTransaction(sampleQuote, "USER_PUBKEY");
    expect(result.swapTransaction).toBe("BASE64TX");
    expect(result.lastValidBlockHeight).toBe(100);

    const [callUrl, init] = (fetchMock.mock.calls as unknown[][])[0] as [string, RequestInit];
    expect(callUrl).toContain("/swap");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.userPublicKey).toBe("USER_PUBKEY");
    expect(body.quoteResponse.outAmount).toBe("11432381");
    expect(body.wrapAndUnwrapSol).toBe(true);
  });
});
