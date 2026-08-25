/**
 * Prompt-injection protection for browser content. Web pages the agent reads can
 * contain text crafted to hijack the model ("ignore previous instructions",
 * hidden HTML-comment instructions, credential-exfiltration requests). Before any
 * page text is handed to the model, it is scanned and the suspicious spans are
 * neutralized. This is pure and deterministic — no model call, no network — so
 * the protection is fully testable.
 */

export interface InjectionFinding {
  pattern: string;
  index: number;
  excerpt: string;
}

interface PatternDef {
  name: string;
  source: string;
  flags: string;
}

const PATTERNS: PatternDef[] = [
  { name: "ignore-previous", source: String.raw`ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions`, flags: "gi" },
  { name: "disregard", source: String.raw`disregard\s+(?:the\s+)?(?:above|previous|prior|system)`, flags: "gi" },
  { name: "reveal-system-prompt", source: String.raw`(?:reveal|print|show|repeat|output)\s+(?:your\s+)?(?:system\s+prompt|initial\s+instructions|hidden\s+prompt)`, flags: "gi" },
  { name: "role-override", source: String.raw`you\s+are\s+now\s+(?:a|an|the)\b`, flags: "gi" },
  { name: "exfiltration", source: String.raw`(?:send|post|email|exfiltrate|leak)\s+(?:the\s+|your\s+)?(?:api[\s_-]?key|password|secret|credentials|token)`, flags: "gi" },
  { name: "hidden-html-instruction", source: String.raw`<!--[\s\S]*?(?:system|assistant|instruction|prompt)[\s\S]*?-->`, flags: "gi" },
];

/**
 * The patterns above, compiled once.
 *
 * Both entry points below ran `new RegExp` per pattern per call, and
 * `sanitizeForModel` calls `scanForInjection` first, so a single sanitize
 * compiled twelve regexes. This runs on every console line a page emits, every
 * page error, and every page-text snapshot, so that cost is paid per line of
 * browser output rather than once. These are `/g`, so state is shared: the scan
 * loop zeroes `lastIndex` before it starts, and `String.replace` manages its
 * own.
 */
const COMPILED = PATTERNS.map((def) => ({ name: def.name, re: new RegExp(def.source, def.flags) }));

export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const { name, re } of COMPILED) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      findings.push({ pattern: name, index: match.index, excerpt: text.slice(match.index, match.index + Math.min(120, match[0].length)) });
      if (match.index === re.lastIndex) re.lastIndex++;
    }
  }
  return findings.sort((a, b) => a.index - b.index || a.pattern.localeCompare(b.pattern));
}

export interface SanitizeResult {
  text: string;
  findings: InjectionFinding[];
}

/** Neutralize injection spans, returning safe text plus what was found. */
export function sanitizeForModel(text: string): SanitizeResult {
  const findings = scanForInjection(text);
  // The scan just proved no pattern matches this text, so the replace chain
  // below could only walk it another six times and return it unchanged. Browser
  // output is overwhelmingly clean, so this is the path nearly every call takes.
  if (findings.length === 0) return { text, findings };
  let sanitized = text;
  for (const { re } of COMPILED) {
    sanitized = sanitized.replace(re, "[redacted: possible prompt injection]");
  }
  return { text: sanitized, findings };
}
