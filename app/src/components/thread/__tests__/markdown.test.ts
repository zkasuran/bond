import { parseInline, parseMarkdownLite } from "../markdown";

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
  });
});
