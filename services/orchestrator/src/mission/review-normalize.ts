import { createHash } from "node:crypto";
import type { MissionCriterion, MissionReview, MissionReviewVerdict, MissionStatus } from "@morrow/contracts";

/**
 * Robust extraction/normalization for the independent reviewer's response.
 *
 * A weaker or "reasoning" model rarely fails to reach a real judgment — it
 * fails to package that judgment as the exact JSON shape asked for: it wraps
 * it in a fence, adds a sentence before or after, uses a close-but-different
 * key name, leaves a trailing comma, or states its verdict as prose instead
 * of JSON. This module tries progressively harder, fully deterministic
 * extraction strategies before ever spending a second provider call, and it
 * NEVER upgrades an ambiguous or unparseable result into an approval: every
 * path that cannot recover a real verdict falls through to the same
 * conservative "insufficient_evidence" shape the caller already treats as
 * non-terminal.
 */

const VERDICTS: readonly MissionReviewVerdict[] = ["approved", "approved_with_risks", "revisions_required", "insufficient_evidence"];
const STATUSES: readonly MissionStatus[] = ["completed", "completed_with_reservations", "partially_completed", "blocked", "failed"];

/** Unambiguous aliases only. Never map a vague/positive word ("looks good",
 * "fine", "great") — those are exactly the false positives this must avoid. */
const VERDICT_ALIASES: Record<string, MissionReviewVerdict> = {
  approve: "approved", approved: "approved", accept: "approved", accepted: "approved",
  approved_with_risks: "approved_with_risks", approve_with_risks: "approved_with_risks",
  conditionally_approved: "approved_with_risks", conditional_approval: "approved_with_risks",
  reject: "revisions_required", rejected: "revisions_required", revisions_required: "revisions_required",
  changes_requested: "revisions_required", needs_revision: "revisions_required", needs_revisions: "revisions_required",
  revision_required: "revisions_required",
  insufficient_evidence: "insufficient_evidence", inconclusive: "insufficient_evidence", unclear: "insufficient_evidence",
};

const STATUS_ALIASES: Record<string, MissionStatus> = {
  completed: "completed", complete: "completed", done: "completed",
  completed_with_reservations: "completed_with_reservations", completed_with_caveats: "completed_with_reservations",
  partially_completed: "partially_completed", partial: "partially_completed",
  blocked: "blocked",
  failed: "failed", fail: "failed",
};

export interface ReviewParseAttempt {
  method: string;
  ok: boolean;
  reason?: string;
}

export interface ReviewParseDiagnostics {
  rawLength: number;
  rawSha256: string;
  finishReason: string | null;
  attempts: ReviewParseAttempt[];
  usedStructuredProseFallback: boolean;
}

export type ParsedReview = Omit<MissionReview, "id" | "missionId" | "createdAt" | "reviewerProvider" | "reviewerModel">;

export function fallbackParsed(reason: string): ParsedReview {
  return {
    verdict: "insufficient_evidence",
    criterionJudgments: [],
    regressionRisks: [],
    suspiciousChanges: [],
    missingVerification: ["Reviewer output could not be parsed into a structured verdict"],
    concerns: ["Reviewer did not return a usable verdict"],
    recommendedStatus: "partially_completed",
    summary: `Reviewer output was not machine-readable; treated as insufficient evidence (${reason}).`,
  };
}

/** sha256 of the raw text, so failures can be diagnosed and correlated across
 * retries/restarts without ever persisting the (possibly sensitive) content. */
export function hashRawReview(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** All brace-delimited substrings that look like top-level JSON objects,
 * scanning outside markdown fences first (most models place the answer
 * there), then the whole text. Returns candidates in the order they should be
 * tried: fenced first, then unfenced; within each, longer/earlier first. */
function candidateJsonSlices(text: string): string[] {
  const slices: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text))) {
    const inner = match[1]!;
    for (const s of bracedSlices(inner)) slices.push(s);
  }
  for (const s of bracedSlices(text)) slices.push(s);
  // De-duplicate while preserving order.
  return [...new Set(slices)];
}

/** Every balanced-brace top-level object substring in `text`, found by
 * scanning brace depth rather than naive first-'{'/last-'}' (which breaks
 * when prose elsewhere in the text contains stray braces). */
function bracedSlices(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start !== -1) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}

/** Bounded, deterministic repairs for minor JSON syntax damage. Each returns a
 * new candidate string; callers re-attempt JSON.parse after each one. Never
 * touches string contents — only structural punctuation between them. */
function repairCandidates(candidate: string): string[] {
  const repairs: string[] = [];
  // Trailing commas before a closing bracket/brace.
  repairs.push(candidate.replace(/,(\s*[}\]])/g, "$1"));
  // Smart quotes → straight quotes (some models emit typographic quotes).
  repairs.push(candidate.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  // Both repairs combined.
  repairs.push(candidate.replace(/,(\s*[}\]])/g, "$1").replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  return repairs;
}

function tryParseJsonCandidate(candidate: string): any {
  try { return JSON.parse(candidate); } catch { /* fall through to repairs */ }
  for (const repaired of repairCandidates(candidate)) {
    try { return JSON.parse(repaired); } catch { /* keep trying */ }
  }
  return null;
}

/** True when `raw` has some recognizable review-shaped field, even under an
 * alias — used to pick the right candidate when a response contains multiple
 * JSON objects (e.g. an example embedded in the reviewer's own explanation
 * followed by its real answer). */
function looksLikeReviewShape(raw: any): boolean {
  if (!raw || typeof raw !== "object") return false;
  const keys = Object.keys(raw).map((k) => k.toLowerCase());
  return keys.some((k) => ["verdict", "decision", "result", "judgement", "judgment", "recommendedstatus", "recommendation", "status"].includes(k));
}

function normalizeVerdict(value: unknown): MissionReviewVerdict | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((VERDICTS as readonly string[]).includes(v)) return v as MissionReviewVerdict;
  return VERDICT_ALIASES[v] ?? null;
}

function normalizeStatus(value: unknown): MissionStatus | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((STATUSES as readonly string[]).includes(v)) return v as MissionStatus;
  return STATUS_ALIASES[v] ?? null;
}

/** Read a value out of `raw` trying the canonical key first, then aliases. */
function readAliased(raw: any, canonical: string, aliases: string[]): unknown {
  if (raw[canonical] !== undefined) return raw[canonical];
  const lowerMap = new Map(Object.keys(raw).map((k) => [k.toLowerCase(), k]));
  for (const alias of aliases) {
    const actualKey = lowerMap.get(alias.toLowerCase());
    if (actualKey !== undefined) return raw[actualKey];
  }
  return undefined;
}

const strArr = (v: unknown): string[] => Array.isArray(v)
  ? v.filter((x) => typeof x === "string").map((x) => (x as string).trim().slice(0, 500)).filter((x) => x && !isNoopReviewListItem(x)).slice(0, 20)
  : [];

function isNoopReviewListItem(value: string): boolean {
  const text = value.trim();
  return /^(?:none|n\/a|not applicable)\b/i.test(text)
    || /^none expected\b/i.test(text)
    || /^no (?:regression )?(?:risks?|concerns?|issues?|problems?|suspicious changes?|missing verification|unresolved risks?)(?:\b|$)/i.test(text);
}

/** Build a ParsedReview from an object once we believe it is review-shaped,
 * accepting aliased keys and case-insensitive enum values. Returns null only
 * when there is no recognizable verdict-ish field at all (caller then tries
 * the next candidate rather than guessing). */
function normalizeReviewObject(raw: any, criteria: MissionCriterion[]): ParsedReview | null {
  if (!raw || typeof raw !== "object") return null;
  const rawVerdict = readAliased(raw, "verdict", ["decision", "result", "judgement", "judgment"]);
  const verdict = normalizeVerdict(rawVerdict);
  if (!verdict) return null; // no recognizable verdict field/value; not this candidate

  const rawStatus = readAliased(raw, "recommendedStatus", ["recommended_status", "recommendation", "status"]);
  const recommendedStatus = normalizeStatus(rawStatus) ?? "partially_completed";

  const rawJudgments = readAliased(raw, "criterionJudgments", ["criterion_judgments", "judgments", "criteriaJudgments"]);
  const criterionJudgments = Array.isArray(rawJudgments)
    ? rawJudgments.map((j: any) => {
        const idxRaw = readAliased(j, "index", ["criterionIndex", "criterion_index"]);
        const idx = typeof idxRaw === "number" ? idxRaw - 1 : -1;
        const criterionIdRaw = readAliased(j, "criterionId", ["criterion_id"]);
        const criterionId = criteria[idx]?.id ?? (typeof criterionIdRaw === "string" ? criterionIdRaw : "");
        const judgmentRaw = readAliased(j, "judgment", ["verdict", "result"]);
        const judgmentNorm = typeof judgmentRaw === "string" ? judgmentRaw.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
        const judgment: "satisfied" | "not_satisfied" | "unclear" =
          ["satisfied", "met", "pass", "passed", "true"].includes(judgmentNorm) ? "satisfied"
          : ["not_satisfied", "unmet", "fail", "failed", "false"].includes(judgmentNorm) ? "not_satisfied"
          : "unclear";
        const note = readAliased(j, "note", ["reason", "explanation"]);
        return { criterionId, judgment, note: typeof note === "string" ? note.slice(0, 1000) : "" };
      }).filter((j: any) => j.criterionId)
    : [];

  return {
    verdict,
    criterionJudgments,
    regressionRisks: strArr(readAliased(raw, "regressionRisks", ["regression_risks"])),
    suspiciousChanges: strArr(readAliased(raw, "suspiciousChanges", ["suspicious_changes"])),
    missingVerification: strArr(readAliased(raw, "missingVerification", ["missing_verification"])),
    concerns: strArr(readAliased(raw, "concerns", ["issues"])),
    recommendedStatus,
    summary: (() => { const s = readAliased(raw, "summary", ["explanation"]); return typeof s === "string" ? s.slice(0, 4000) : ""; })(),
  };
}

/** Narrow structured-prose fallback, used ONLY when no JSON candidate parsed
 * at all. Requires an explicit, standalone "verdict: <value>"-style line —
 * never inferred from surrounding positive/negative language, so a reviewer
 * musing "this looks fine but I'm not certain" can never read as approval. */
function extractStructuredProseVerdict(text: string): { verdict: MissionReviewVerdict; recommendedStatus: MissionStatus; summary: string } | null {
  const lineRe = /^\s*(?:final\s+)?(?:verdict|judgment|judgement|decision)\s*[:=]\s*"?([a-z_ ]+?)"?\s*$/im;
  const match = lineRe.exec(text);
  if (!match) return null;
  const verdict = normalizeVerdict(match[1]);
  if (!verdict) return null;
  const statusLine = /^\s*(?:recommended\s*status|status)\s*[:=]\s*"?([a-z_ ]+?)"?\s*$/im.exec(text);
  const recommendedStatus = (statusLine && normalizeStatus(statusLine[1])) ?? (verdict === "approved" ? "completed" : "partially_completed");
  return { verdict, recommendedStatus, summary: `Recovered from structured prose verdict line: "${match[0].trim()}"` };
}

/**
 * The full bounded, deterministic normalization pipeline. Never performs a
 * network call itself — the caller (mission/service.ts) decides whether a
 * dedicated repair call is worth making when this returns a parse failure.
 */
export function parseReviewVerdictRobust(
  text: string,
  criteria: MissionCriterion[],
  opts: { finishReason?: string | null } = {},
): { parsed: ParsedReview; diagnostics: ReviewParseDiagnostics } {
  const attempts: ReviewParseAttempt[] = [];
  const diagnostics: ReviewParseDiagnostics = {
    rawLength: text.length,
    rawSha256: hashRawReview(text),
    finishReason: opts.finishReason ?? null,
    attempts,
    usedStructuredProseFallback: false,
  };

  if (!text.trim()) {
    attempts.push({ method: "empty_response", ok: false, reason: opts.finishReason === "length" ? "response truncated before any content was emitted" : "empty response" });
    return { parsed: fallbackParsed("empty response"), diagnostics };
  }

  const candidates = candidateJsonSlices(text);
  attempts.push({ method: "candidate_scan", ok: candidates.length > 0, reason: `${candidates.length} candidate object(s) found` });

  let bestNonSchemaParsed: ParsedReview | null = null;
  for (const candidate of candidates) {
    const raw = tryParseJsonCandidate(candidate);
    if (raw === null) { attempts.push({ method: "json_parse", ok: false, reason: "candidate did not parse even after bounded repair" }); continue; }
    if (!looksLikeReviewShape(raw)) { attempts.push({ method: "schema_match", ok: false, reason: "parsed object lacks a recognizable verdict field" }); continue; }
    const normalized = normalizeReviewObject(raw, criteria);
    if (normalized) {
      attempts.push({ method: "json_parse", ok: true });
      return { parsed: normalized, diagnostics };
    }
    bestNonSchemaParsed = bestNonSchemaParsed ?? null;
  }

  const prose = extractStructuredProseVerdict(text);
  if (prose) {
    diagnostics.usedStructuredProseFallback = true;
    attempts.push({ method: "structured_prose", ok: true });
    return {
      parsed: {
        verdict: prose.verdict,
        criterionJudgments: [],
        regressionRisks: [],
        suspiciousChanges: [],
        missingVerification: prose.verdict === "approved" ? [] : ["Recovered verdict via structured prose fallback; criterion-level judgments were not recoverable"],
        concerns: [],
        recommendedStatus: prose.recommendedStatus,
        summary: prose.summary,
      },
      diagnostics,
    };
  }
  attempts.push({ method: "structured_prose", ok: false, reason: "no unambiguous verdict line found" });

  return { parsed: fallbackParsed(candidates.length > 0 ? "no candidate matched the review schema" : "no JSON object found"), diagnostics };
}

/** True exactly when `parsed` is one of this module's own conservative
 * fallbacks (never true for a genuine reviewer-issued insufficient_evidence
 * verdict with real content, so a legitimate rejection is never mistaken for
 * a parse failure and retried pointlessly). */
export function isReviewParseFailure(parsed: ParsedReview): boolean {
  return parsed.verdict === "insufficient_evidence"
    && parsed.missingVerification.includes("Reviewer output could not be parsed into a structured verdict")
    && parsed.summary.startsWith("Reviewer output was not machine-readable; treated as insufficient evidence");
}
