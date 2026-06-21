import { Output } from "./output.js";

/**
 * Minimal, dependency-free Markdown renderer for the terminal. Handles the
 * subset that matters for assistant answers: headings, bold/italic, inline
 * code, fenced code blocks (with a language label), bullet/numbered lists,
 * blockquotes, and links. Unknown syntax passes through as plain text.
 */
export function renderMarkdown(md: string, out: Output): string {
  if (!out.color) {
    // Plain mode: keep code fences readable but strip decorative markers.
    return md;
  }
  const lines = md.split("\n");
  const result: string[] = [];
  let inFence = false;
  let fenceLang = "";

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = (fence[1] ?? "").trim();
        result.push(out.gray(`┌─ ${fenceLang || "code"} ${"─".repeat(Math.max(0, 40 - fenceLang.length))}`));
      } else {
        inFence = false;
        result.push(out.gray("└" + "─".repeat(44)));
      }
      continue;
    }
    if (inFence) {
      result.push(out.gray("│ ") + out.cyan(line));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      result.push(out.bold(out.underline(heading[2] ?? "")));
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      result.push(out.gray("│ ") + out.italic(inline(quote[1] ?? "", out)));
      continue;
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      result.push(`${bullet[1] ?? ""}${out.gray("•")} ${inline(bullet[2] ?? "", out)}`);
      continue;
    }
    const num = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (num) {
      result.push(`${num[1] ?? ""}${out.gray((num[2] ?? "") + ".")} ${inline(num[3] ?? "", out)}`);
      continue;
    }
    result.push(inline(line, out));
  }
  return result.join("\n");
}

function inline(text: string, out: Output): string {
  let s = text;
  // inline code first to avoid formatting inside it
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => out.cyan(code));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => out.bold(b));
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, (_m, pre: string, it: string) => pre + out.italic(it));
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => `${out.underline(label)} ${out.gray("(" + url + ")")}`);
  return s;
}
