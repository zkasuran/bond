import { MAX_LINE_CHARS, MAX_LINES, parseInline, parseMarkdownLite } from "../markdown";

describe("markdown-lite", () => {
  it("splits bold and inline code out of plain text", () => {
    expect(parseInline("SOL: **1** at `Guv`")).toEqual([
      { text: "SOL: " },
      { text: "1", bold: true },
      { text: " at " },
      { text: "Guv", code: true },
    ]);
  });

  it("leaves unmatched markers as literal text", () => {
    expect(parseInline("2 * 3 and `open")).toEqual([{ text: "2 * 3 and `open" }]);
  });

  it("marks bullets and trims surrounding blank lines", () => {
    const lines = parseMarkdownLite("\nHere:\n\n- **SOL**: 1\n* USDC: 0\n");
    expect(lines.map((l) => l.bullet)).toEqual([false, false, true, true]);
    expect(lines[2]?.spans).toEqual([{ text: "SOL", bold: true }, { text: ": 1" }]);
  });

  it("never interprets links or html", () => {
    expect(parseInline("[x](javascript:alert(1)) <b>")).toEqual([{ text: "[x](javascript:alert(1)) <b>" }]);
    expect(parseInline("<img src=x onerror=alert(1)> <script>alert(1)</script>")).toEqual([
      { text: "<img src=x onerror=alert(1)> <script>alert(1)</script>" },
    ]);
  });

  it("caps the rendered line count on a huge body (F16 LOW)", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    expect(parseMarkdownLite(body).length).toBeLessThanOrEqual(MAX_LINES + 1);
  });

  it("truncates an enormous single line (F16 LOW)", () => {
    const [first] = parseMarkdownLite("a".repeat(100000));
    const text = first.spans.map((s) => s.text).join("");
    expect(text.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 1);
  });
});

import { summarize } from "../receipt";

describe("tool summary line", () => {
  it("leads with the scalar fields and shortens long values", () => {
    expect(summarize('{"ok":true,"symbol":"SOL","usdcPrice":121.62519806784131,"source":"Jupiter, mainnet"}')).toBe(
      "symbol: SOL · usdcPrice: 121.625 · source: Jupite…nnet",
    );
  });
  it("surfaces an error first", () => {
    expect(summarize('{"ok":false,"error":"cap exceeded","amount":900}')).toBe("error: cap exceeded · amount: 900");
  });
  it("falls back to trimmed text when the result is not JSON", () => {
    expect(summarize("  plain\n text ")).toBe("plain text");
  });
});
