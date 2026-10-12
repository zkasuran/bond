import { padKeys, shuffledDigits } from "../shuffle";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

describe("PIN pad shuffle", () => {
  it("always returns each digit exactly once", () => {
    for (let i = 0; i < 200; i++) expect([...shuffledDigits()].sort()).toEqual(DIGITS);
  });

  it("is a Fisher-Yates over the supplied picker", () => {
    // pick(n) = 0 swaps each position i with 0 in turn.
    expect(shuffledDigits(() => 0)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
    // pick(n) = n - 1 swaps each position with itself: the identity.
    expect(shuffledDigits((n) => n - 1)).toEqual(DIGITS);
  });

  it("moves digits around across showings (not the fixed 1 2 3 layout)", () => {
    const firstKeys = new Set<string>();
    for (let i = 0; i < 100; i++) firstKeys.add(shuffledDigits()[0]!);
    // With a uniform shuffle all ten digits land in the first slot over 100 draws (fails ~0.003%).
    expect(firstKeys.size).toBe(10);
  });

  it("lays out nine digits, a blank, the tenth digit and delete", () => {
    const keys = padKeys(shuffledDigits((n) => n - 1));
    expect(keys).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "", "9", "del"]);
    expect(keys).toHaveLength(12);
  });

  it("fails closed with no CSPRNG instead of falling back to a predictable order", () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(() => shuffledDigits()).toThrow(/CSPRNG/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    }
  });
});
