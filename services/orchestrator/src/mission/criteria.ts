import type { MissionVerificationStrategy, MissionVerificationKind } from "@morrow/contracts";

/**
 * Success-criteria generation. A mission converts a free-text objective into
 * measurable, verifiable criteria BEFORE substantial execution. Vague criteria
 * are rejected/rewritten; every criterion carries a concrete verification
 * strategy that produces evidence.
 */

export interface DraftCriterion {
  description: string;
  verification: MissionVerificationStrategy;
}

const VAGUE_PATTERNS = [
  /^make it better$/i,
  /^ensure quality$/i,
  /^fix everything$/i,
  /^improve( the)? (code|project|quality)$/i,
  /^clean( it)? up$/i,
  /^(do|make) (it )?good$/i,
  /^works? (well|correctly|properly)$/i,
];

/** A criterion is too vague when it names no observable, checkable outcome. */
export function isVagueCriterion(description: string): boolean {
  const d = description.trim();
  if (d.length < 8) return true;
  if (VAGUE_PATTERNS.some((p) => p.test(d))) return true;
  // Purely subjective adjectives with no observable noun/verb.
  if (/^(better|nicer|cleaner|good|great|quality)\.?$/i.test(d)) return true;
  return false;
}

/** Rewrite a vague criterion into an observable outcome where possible. */
export function rewriteVague(description: string): string {
  const d = description.trim();
  if (/quality/i.test(d)) return "Type-checking and the existing test suite pass without new errors";
  if (/works?|good|better|properly|correctly/i.test(d)) return "The application starts and its primary runtime path completes without errors";
  if (/clean/i.test(d)) return "No unrelated files change and lint reports no new violations";
  return d;
}

/**
 * The prompt shown to the planning model. It demands measurable criteria and a
 * verification method per criterion, and forbids vague outcomes.
 */
export function buildCriteriaPrompt(objective: string, repoSummary: string): string {
  return [
    "You are Morrow's mission planner. Convert the objective into 3-6 MEASURABLE, independently VERIFIABLE success criteria.",
    "Each criterion MUST be provable by a concrete action (a command with an exit code, a test, a build, a type-check, an HTTP probe, or a bounded diff inspection).",
    "Reject vague outcomes like 'make it better' or 'ensure quality'. Rewrite them into observable results.",
    "",
    "Return ONLY a JSON array. Each element: {\"description\": string, \"verification\": {\"kind\": one of command|test|build|typecheck|lint|runtime|http|diff|manual, \"command\"?: string, \"url\"?: string, \"expectStatus\"?: number, \"expectExitCode\"?: number, \"pathScope\"?: string, \"describe\"?: string}}.",
    "Prefer commands that run in this repository. Keep commands safe and non-destructive.",
    "",
    `OBJECTIVE:\n${objective}`,
    "",
    `REPOSITORY CONTEXT:\n${repoSummary}`,
  ].join("\n");
}

/**
 * Parse the model's JSON array of criteria. Tolerant of code fences and
 * surrounding prose. Invalid entries are dropped; vague ones are rewritten.
 * Returns [] when nothing parseable is found (caller falls back to heuristics).
 */
export function parseCriteriaFromModel(text: string): DraftCriterion[] {
  const json = extractJsonArray(text);
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: DraftCriterion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    let description = typeof e.description === "string" ? e.description.trim() : "";
    if (!description) continue;
    if (isVagueCriterion(description)) description = rewriteVague(description);
    const verification = normalizeVerification(e.verification, description);
    out.push({ description, verification });
  }
  return out;
}

function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

const VALID_KINDS: MissionVerificationKind[] = ["command", "test", "build", "typecheck", "lint", "runtime", "http", "browser", "diff", "review", "manual", "artifact"];

function normalizeVerification(v: unknown, description: string): MissionVerificationStrategy {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const kind = VALID_KINDS.includes(o.kind as MissionVerificationKind) ? (o.kind as MissionVerificationKind) : inferKind(description);
    const strat: MissionVerificationStrategy = { kind };
    if (typeof o.command === "string" && o.command.trim()) strat.command = o.command.trim().slice(0, 2000);
    if (typeof o.url === "string" && o.url.trim()) strat.url = o.url.trim().slice(0, 2000);
    if (typeof o.expectStatus === "number") strat.expectStatus = o.expectStatus;
    if (typeof o.expectExitCode === "number") strat.expectExitCode = o.expectExitCode;
    if (typeof o.pathScope === "string" && o.pathScope.trim()) strat.pathScope = o.pathScope.trim().slice(0, 500);
    if (typeof o.describe === "string") strat.describe = o.describe.slice(0, 500);
    return strat;
  }
  return { kind: inferKind(description) };
}

function inferKind(description: string): MissionVerificationKind {
  const d = description.toLowerCase();
  if (/syntax|parse|node --check/.test(d)) return "command";
  if (/http|serve|status 200|responds|endpoint/.test(d)) return "http";
  if (/\btest(s)?\b|spec|assertion/.test(d)) return "test";
  if (/build|compile/.test(d)) return "build";
  if (/type[- ]?check|types?\b/.test(d)) return "typecheck";
  if (/lint/.test(d)) return "lint";
  if (/diff|unrelated changes|only .* changes/.test(d)) return "diff";
  if (/reviewer|independent review/.test(d)) return "review";
  return "manual";
}
