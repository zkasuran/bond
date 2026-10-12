// Digit layout for the PIN pad. The ten digits are placed in a fresh random order every time
// the pad is shown, so someone watching where a finger lands (a shoulder surfer, a camera, a
// smudge pattern) does not learn the PIN. Delete keeps its fixed corner so it is easy to find.

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export type Digit = (typeof DIGITS)[number];

/** A uniform integer in [0, n) from a CSPRNG, by rejection so no value is favoured. */
function cryptoIndex(n: number): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("No CSPRNG available for the PIN pad shuffle.");
  }
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    c.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

/** The ten digits in a random order (Fisher-Yates). `pick(n)` returns an integer in [0, n);
 *  tests pass a deterministic one. */
export function shuffledDigits(pick: (n: number) => number = cryptoIndex): Digit[] {
  const out: Digit[] = [...DIGITS];
  for (let i = out.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The 12 pad slots: nine shuffled digits, a blank, the tenth digit, then delete. */
export function padKeys(digits: Digit[]): (Digit | "" | "del")[] {
  return [...digits.slice(0, 9), "", digits[9]!, "del"];
}
