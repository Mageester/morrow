/**
 * Markdown, parsed into blocks and inline spans.
 *
 * Pure and rendererless on purpose: `src/cli/markdown.ts` emits an ANSI string
 * for the non-interactive commands, which is the right shape there and the
 * wrong one inside Ink — raw escape codes defeat Ink's width measurement and
 * wrap in the wrong places. Both surfaces need the same grammar, so the grammar
 * lives here and each renderer draws it its own way.
 *
 * The subset is the one assistant answers actually use: headings, fenced code,
 * bullet and numbered lists, blockquotes, horizontal rules, and the inline run
 * of bold / italic / code / links. Anything unrecognised passes through as
 * text, because dropping a line that failed to parse is worse than showing its
 * markers.
 */

export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "heading"; level: number; spans: InlineSpan[] }
  | { kind: "bullet"; spans: InlineSpan[]; depth: number }
  | { kind: "numbered"; spans: InlineSpan[]; marker: string; depth: number }
  | { kind: "quote"; spans: InlineSpan[] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "rule" }
  | { kind: "blank" };

// Emphasis must open and close on a non-space character. Without that guard
// `2 * 3 * 4` parses as an italic run and arithmetic silently becomes prose.
const INLINE =
  /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*(?!\s)[^*]*[^\s*]\*|_(?!\s)[^_]*[^\s_]_)/;

/** Split one line into styled spans. Unmatched text stays text. */
export function parseInline(input: string): InlineSpan[] {
  if (!input) return [];
  const spans: InlineSpan[] = [];
  let rest = input;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      spans.push({ kind: "text", text: rest });
      break;
    }
    if (match.index > 0) spans.push({ kind: "text", text: rest.slice(0, match.index) });
    const token = match[0];

    if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ kind: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      spans.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) spans.push({ kind: "link", text: link[1] ?? "", href: link[2] ?? "" });
      else spans.push({ kind: "text", text: token });
    } else {
      spans.push({ kind: "italic", text: token.slice(1, -1) });
    }
    rest = rest.slice(match.index + token.length);
  }
  return spans;
}

/** Parse a markdown document into blocks. */
export function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const lang = (fence[1] ?? "").trim();
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end rather than swallowing the rest
      // of the answer into a block that never closes.
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", lang, lines: body });
      continue;
    }

    if (/^\s*$/.test(line)) {
      blocks.push({ kind: "blank" });
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        spans: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push({ kind: "quote", spans: parseInline(quote[1] ?? "") });
      index += 1;
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({
        kind: "bullet",
        depth: Math.floor((bullet[1] ?? "").length / 2),
        spans: parseInline(bullet[2] ?? ""),
      });
      index += 1;
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push({
        kind: "numbered",
        depth: Math.floor((numbered[1] ?? "").length / 2),
        marker: `${numbered[2]}.`,
        spans: parseInline(numbered[3] ?? ""),
      });
      index += 1;
      continue;
    }

    blocks.push({ kind: "paragraph", spans: parseInline(line) });
    index += 1;
  }

  return blocks;
}
