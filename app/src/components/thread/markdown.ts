/**
 * A deliberately small inline-markdown reader for agent replies. Models answer in
 * light markdown (bold, inline code, bullet lists); showing the raw asterisks and
 * backticks in a chat bubble reads as broken. This handles only those three forms
 * and never interprets links or HTML, so it cannot be used to inject anything.
 */
export type InlineSpan = { text: string; bold?: boolean; code?: boolean };
export type MdLine = { bullet: boolean; spans: InlineSpan[] };

const TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

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

/** Split a reply into lines, marking "- " and "* " bullets, with leading and trailing blank lines dropped. */
export function parseMarkdownLite(body: string): MdLine[] {
  const lines = body.replace(/\r\n/g, "\n").trim().split("\n");
  return lines.map((raw) => {
    const m = /^\s*[-*]\s+(.*)$/.exec(raw);
    return m ? { bullet: true, spans: parseInline(m[1] ?? "") } : { bullet: false, spans: parseInline(raw) };
  });
}
