/**
 * A deliberately small inline-markdown reader for agent replies. Models answer in
 * light markdown (bold, inline code, bullet lists); showing the raw asterisks and
 * backticks in a chat bubble reads as broken. This handles only those three forms
 * and never interprets links or HTML, so it cannot be used to inject anything.
 */
export type InlineSpan = { text: string; bold?: boolean; code?: boolean };
export type MdLine = { bullet: boolean; spans: InlineSpan[] };

const TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

/** Render-side ceilings on an untrusted body. A node from the relay has no independent cap
 *  at render, so a body with tens of thousands of lines, or one enormous line, is truncated
 *  here before it becomes one View per line. Resource exhaustion, not injection: the parser
 *  itself is linear and never interprets markup. */
export const MAX_BODY_CHARS = 8000;
export const MAX_LINES = 300;
export const MAX_LINE_CHARS = 2000;

export function parseInline(line: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: line.slice(last, i) });
    const tok = m[0];
    if (tok.startsWith("**")) out.push({ text: tok.slice(2, -2), bold: true });
    else out.push({ text: tok.slice(1, -1), code: true });
    last = i + tok.length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

/** Split a reply into lines, marking "- " and "* " bullets, with leading and trailing blank
 *  lines dropped. The body, the line count and each line length are capped first, with an
 *  ellipsis marking a truncation, so an oversized node cannot jank or hang the thread. */
export function parseMarkdownLite(body: string): MdLine[] {
  const capped = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : body;
  const lines = capped.replace(/\r\n/g, "\n").trim().split("\n");
  const truncatedLines = lines.length > MAX_LINES;
  const kept = truncatedLines ? lines.slice(0, MAX_LINES) : lines;
  const out = kept.map((raw) => {
    const clipped = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…` : raw;
    const m = /^\s*[-*]\s+(.*)$/.exec(clipped);
    return m ? { bullet: true, spans: parseInline(m[1] ?? "") } : { bullet: false, spans: parseInline(clipped) };
  });
  if (truncatedLines) out.push({ bullet: false, spans: [{ text: "…" }] });
  return out;
}
