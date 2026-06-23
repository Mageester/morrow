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

export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const def of PATTERNS) {
    const re = new RegExp(def.source, def.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      findings.push({ pattern: def.name, index: match.index, excerpt: text.slice(match.index, match.index + Math.min(120, match[0].length)) });
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
  let sanitized = text;
  for (const def of PATTERNS) {
    sanitized = sanitized.replace(new RegExp(def.source, def.flags), "[redacted: possible prompt injection]");
  }
  return { text: sanitized, findings };
}
