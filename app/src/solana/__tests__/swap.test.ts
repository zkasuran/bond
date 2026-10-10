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

import { Buffer } from "buffer";
import { setFetchImpl } from "../../bridge/net";
import { explorerTxUrl } from "../explorer";
import {
  assertSwapTransactionMatchesQuote,
  deserializeSwapTransaction,
  getQuote,
  getSwapTransaction,
  JUPITER_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  summarizeQuote,
  type JupiterQuote,
} from "../swap";

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

// The Jupiter fetch runs through the app streaming fetch (getStreamingFetch), the same path the
// device uses, so tests inject with setFetchImpl rather than mocking the global fetch. expo/fetch
// exposes a readable body, so a realistic device response is modelled with a getReader stream.
function streamResponse(
  bodyText: string,
  init: { ok?: boolean; status?: number; contentLength?: string | null } = {},
): Response {
  const bytes = Uint8Array.from(Buffer.from(bodyText, "utf8"));
  let sent = false;
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      if (sent) return { done: true, value: undefined };
      sent = true;
      return { done: false, value: bytes };
    },
    cancel: async () => {},
  };
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => init.contentLength ?? null },
    body: { getReader: () => reader },
  } as unknown as Response;
}

function streamJson(value: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return streamResponse(JSON.stringify(value), init);
}

afterEach(() => {
  jest.restoreAllMocks();
  setFetchImpl(null);
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
    const fetchMock = jest.fn(async () => streamJson(sampleQuote));
    setFetchImpl(fetchMock);

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
    setFetchImpl(async () => streamResponse("rate limited", { ok: false, status: 429 }));
    await expect(getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 })).rejects.toThrow(/429/);
  });
});

describe("getSwapTransaction", () => {
  it("posts the quote and user pubkey and returns the base64 transaction", async () => {
    const fetchMock = jest.fn(async () =>
      streamJson({
        swapTransaction: "BASE64TX",
        lastValidBlockHeight: 100,
        prioritizationFeeLamports: 5000,
      }),
    );
    setFetchImpl(fetchMock);

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

describe("response-size cap and body-read timeout", () => {
  it("rejects an oversized streamed body regardless of content-length", async () => {
    const chunk = new Uint8Array(600_000);
    let reads = 0;
    const cancel = jest.fn(async () => {});
    const reader = {
      read: jest.fn(async () => {
        reads += 1;
        if (reads <= 2) return { done: false, value: chunk };
        return { done: true, value: undefined };
      }),
      cancel,
    };
    setFetchImpl(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: { getReader: () => reader },
        }) as unknown as Response,
    );
    await expect(getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 })).rejects.toThrow(
      /too large/i,
    );
    expect(cancel).toHaveBeenCalled();
  });

  it("routes the Jupiter fetch through the app streaming fetch so the cap applies on device", async () => {
    // The device uses React Native's built-in fetch, which does not stream, so the request must
    // go through getStreamingFetch (expo/fetch). Prove getQuote calls the injected streaming impl
    // and that its readable body is counted and refused mid-stream, not buffered.
    const chunk = new Uint8Array(MAX_RESPONSE_BYTES);
    let reads = 0;
    const cancel = jest.fn(async () => {});
    const reader = {
      read: jest.fn(async () => {
        reads += 1;
        return reads <= 2 ? { done: false, value: chunk } : { done: true, value: undefined };
      }),
      cancel,
    };
    const streamingImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: { getReader: () => reader },
        }) as unknown as Response,
    );
    setFetchImpl(streamingImpl);
    // Deliberately leave the bare global fetch unset: the fixed path must use getStreamingFetch.
    await expect(getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 })).rejects.toThrow(
      /too large/i,
    );
    expect(streamingImpl).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses a chunked device response with no readable stream and no content-length before it is buffered", async () => {
    // The exact V12 shipped-device gap: React Native's built-in fetch exposes no readable body,
    // and a chunked (or MITM) response declares no content-length, so the old code fell to text()
    // and buffered the whole hostile body before measuring it. text() must never run.
    const text = jest.fn(async () => "x".repeat(MAX_RESPONSE_BYTES * 4));
    const hostile = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text,
    } as unknown as Response;
    const impl = jest.fn(async () => hostile);
    setFetchImpl(impl);
    (global as { fetch?: unknown }).fetch = impl; // also drives the pre-fix global-fetch path
    await expect(getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 })).rejects.toThrow(
      /refusing to buffer|declared no length/i,
    );
    expect(text).not.toHaveBeenCalled();
  });

  it("rejects a non-streaming response that declares a length over the cap before buffering", async () => {
    const text = jest.fn(async () => "x".repeat(MAX_RESPONSE_BYTES + 1));
    setFetchImpl(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => String(MAX_RESPONSE_BYTES + 1) },
          text,
        }) as unknown as Response,
    );
    await expect(getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 })).rejects.toThrow(
      /too large/i,
    );
    expect(text).not.toHaveBeenCalled();
  });

  it("reads a small non-streaming response only when its declared length is within the cap", async () => {
    const text = jest.fn(async () => JSON.stringify(sampleQuote));
    setFetchImpl(
      async () =>
        ({ ok: true, status: 200, headers: { get: () => "512" }, text }) as unknown as Response,
    );
    const quote = await getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 });
    expect(quote.outAmount).toBe("11432381");
    expect(text).toHaveBeenCalled();
  });

  it("times out when a streamed response body never finishes", async () => {
    jest.useFakeTimers();
    try {
      const never = new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
      const reader = { read: () => never, cancel: async () => {} };
      setFetchImpl(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: { getReader: () => reader },
          }) as unknown as Response,
      );
      const p = getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 });
      const expectation = expect(p).rejects.toThrow(/timed out/i);
      await jest.advanceTimersByTimeAsync(JUPITER_TIMEOUT_MS + 10);
      await expectation;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("getQuote runtime validation", () => {
  it("rejects a quote whose amount field is not an integer string", async () => {
    const bad = { ...sampleQuote, outAmount: "1.5" };
    setFetchImpl(async () => streamJson(bad));
    await expect(getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 })).rejects.toThrow(
      /malformed/i,
    );
  });

  it("rejects a quote missing a required amount field", async () => {
    const rest = { ...sampleQuote } as Partial<JupiterQuote>;
    delete rest.outAmount;
    setFetchImpl(async () => streamJson(rest));
    await expect(getQuote({ inputMint: "IN", outputMint: "OUT", amount: 1 })).rejects.toThrow(
      /malformed/i,
    );
  });

  it("summarizeQuote returns safe zeros on hostile amount fields instead of throwing", () => {
    const hostile = {
      ...sampleQuote,
      inAmount: "NaN",
      outAmount: "1.5",
      otherAmountThreshold: "abc",
      priceImpactPct: "oops",
    } as unknown as JupiterQuote;
    const s = summarizeQuote(hostile, 9, 6);
    expect(s.inUiAmount).toBe("0");
    expect(s.outUiAmount).toBe("0");
    expect(s.minReceivedUiAmount).toBe("0");
    expect(s.priceImpactPct).toBe(0);
    expect(s.rate).toBe(0);
  });
});

describe("swap transaction guard", () => {
  const validB64 = Buffer.from(new Uint8Array(120)).toString("base64");

  it("decodes a well-formed payload", () => {
    expect(deserializeSwapTransaction(validB64)).toEqual({ versioned: true });
  });

  it("rejects an empty or non-base64 payload before decode", () => {
    expect(() => deserializeSwapTransaction("")).toThrow(/no transaction/i);
    expect(() => deserializeSwapTransaction("@@not base64@@")).toThrow(/base64/i);
  });

  it("rejects an oversized payload before decode", () => {
    const huge = "A".repeat(4000); // decodes to ~3000 bytes, over the 1232 byte ceiling
    expect(() => deserializeSwapTransaction(huge)).toThrow(/out of bounds/i);
  });

  it("fails closed when expectations are given but the transaction cannot be inspected", () => {
    expect(() =>
      deserializeSwapTransaction(validB64, {
        userPublicKey: "USER",
        inputMint: "IN",
        outputMint: "OUT",
      }),
    ).toThrow(/could not be inspected|unverified/i);
  });
});

describe("assertSwapTransactionMatchesQuote", () => {
  const key = (v: string) => ({ toBase58: () => v });
  const tx = (keys: string[]) => ({ message: { staticAccountKeys: keys.map(key) } });
  const expectation = { userPublicKey: "USER", inputMint: "INMINT", outputMint: "OUTMINT" };

  it("accepts a transaction whose fee payer and mints match the quote", () => {
    const good = tx(["USER", "INMINT", "OUTMINT", "PROGRAM"]);
    expect(assertSwapTransactionMatchesQuote(good, expectation)).toBe(good);
  });

  it("rejects a transaction whose fee payer is not the connected wallet", () => {
    expect(() => assertSwapTransactionMatchesQuote(tx(["ATTACKER", "INMINT", "OUTMINT"]), expectation)).toThrow(
      /fee payer/i,
    );
  });

  it("rejects a transaction missing a quoted mint", () => {
    expect(() => assertSwapTransactionMatchesQuote(tx(["USER", "INMINT"]), expectation)).toThrow(
      /mint/i,
    );
  });

  it("fails closed when the transaction cannot be inspected", () => {
    expect(() => assertSwapTransactionMatchesQuote({ versioned: true }, expectation)).toThrow(
      /could not be inspected|unverified/i,
    );
  });
});

describe("explorerTxUrl injection safety", () => {
  it("builds a devnet url with the signature encoded", () => {
    expect(explorerTxUrl("abc123", "devnet")).toBe(
      "https://explorer.solana.com/tx/abc123?cluster=devnet",
    );
  });

  it("defaults to devnet and uses the bare path on mainnet", () => {
    expect(explorerTxUrl("sig")).toBe("https://explorer.solana.com/tx/sig?cluster=devnet");
    expect(explorerTxUrl("sig", "mainnet-beta")).toBe("https://explorer.solana.com/tx/sig");
  });

  it("encodes a hostile signature so it cannot change host, scheme or inject a query", () => {
    const hostile = "javascript:alert(1)#/../../evil?x=y&cluster=mainnet-beta";
    const url = explorerTxUrl(hostile, "devnet");
    expect(url.startsWith("https://explorer.solana.com/tx/")).toBe(true);
    expect(url).not.toContain("javascript:");
    expect(url).toContain(encodeURIComponent(hostile));
    expect(url.slice(url.indexOf("?") + 1)).toBe("cluster=devnet");
  });

  it("cannot inject an open redirect through the signature", () => {
    const url = explorerTxUrl("//evil.com/x", "mainnet-beta");
    expect(url).toBe(`https://explorer.solana.com/tx/${encodeURIComponent("//evil.com/x")}`);
    expect(url).not.toContain("//evil.com");
  });
});
