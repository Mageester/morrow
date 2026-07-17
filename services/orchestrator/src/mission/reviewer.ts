import type { MissionCriterion, MissionEvidence, MissionFailure } from "@morrow/contracts";
import type { ChatMessage } from "../provider/base.js";
import { parseReviewVerdictRobust, isReviewParseFailure as isReviewParseFailureRobust, hashRawReview, fallbackParsed, type ParsedReview, type ReviewParseDiagnostics } from "./review-normalize.js";

export type { ParsedReview, ReviewParseDiagnostics };
export { hashRawReview, fallbackParsed };

/**
 * Independent final review. The reviewer is a SEPARATE execution with isolated
 * instructions. It is deliberately NOT given the implementing agent's narrative
 * or persuasive claims — only the objective, approved criteria, the diff, the
 * evidence ledger, and unresolved failures. It must return a structured verdict.
 */

export interface ReviewContext {
  objective: string;
  criteria: MissionCriterion[];
  evidence: MissionEvidence[];
  failures: MissionFailure[];
  diff: string;
  changedFiles: string[];
}

/**
 * Build the reviewer's messages. The system message hard-frames the reviewer as
 * an adversarial independent auditor and forbids trusting claims. No implementer
 * commentary is included.
 */
/** Evidence entries are bounded so the request stays small and the schema
 * stays the easiest possible target for a weaker or reasoning-heavy model:
 * the most recent entries are the ones a reviewer needs. */
const MAX_EVIDENCE_ENTRIES = 30;

export function buildReviewMessages(ctx: ReviewContext): ChatMessage[] {
  const criteriaBlock = ctx.criteria.map((c, i) =>
    `${i + 1}. [${c.state}] ${c.description}\n   verification: ${c.verification.kind}${c.verification.command ? ` (\`${c.verification.command}\`)` : ""}\n   evidence: ${c.evidenceIds.length} record(s)`,
  ).join("\n");

  const boundedEvidence = ctx.evidence.slice(-MAX_EVIDENCE_ENTRIES);
  const evidenceBlock = boundedEvidence.map((e) =>
    `- [${e.status}] ${e.type}: ${e.summary}${e.exitCode !== null ? ` (exit ${e.exitCode})` : ""}`,
  ).join("\n") || "(no evidence recorded)";
  const evidenceOmittedNote = ctx.evidence.length > boundedEvidence.length
    ? `\n(${ctx.evidence.length - boundedEvidence.length} earlier evidence record(s) omitted for brevity)` : "";

  const failuresBlock = ctx.failures.length
    ? ctx.failures.map((f) => `- [${f.category}] ${f.operation}: ${f.recovered ? "recovered" : "UNRESOLVED"}`).join("\n")
    : "(no failures recorded)";

  // One compact schema, one explicit verdict enum, no unnecessary prose
  // requirement: this is the entire contract, stated once, unambiguously.
  const system = [
    "You are an INDEPENDENT reviewer auditing whether a coding mission actually met its success criteria.",
    "You did NOT do the work and you must not assume it was done correctly.",
    "Judge ONLY from the objective, the approved criteria, the concrete evidence, the diff, and unresolved failures below.",
    "Do not accept any claim of success that is not backed by evidence in this message.",
    "A criterion with no passing evidence is NOT satisfied. Flag suspicious or unrelated changes.",
    "",
    "Respond with ONLY this JSON object. No markdown, no code fences, no text before or after it, no explanation of your reasoning:",
    '{"verdict":"approved|approved_with_risks|revisions_required|insufficient_evidence",',
    '"criterionJudgments":[{"index":1,"judgment":"satisfied|not_satisfied|unclear","note":"..."}],',
    '"regressionRisks":[],"suspiciousChanges":[],"missingVerification":[],"concerns":[],',
    '"recommendedStatus":"completed|completed_with_reservations|partially_completed|blocked|failed",',
    '"summary":"..."}',
    "verdict must be exactly one of: approved, approved_with_risks, revisions_required, insufficient_evidence.",
    "Use 'approved' only when every criterion is satisfied by evidence with no material risk.",
    "Use 'insufficient_evidence' when criteria are claimed done but evidence is missing.",
    "The JSON object is your entire response. Do not write anything before or after it.",
  ].join("\n");

  const user = [
    `OBJECTIVE:\n${ctx.objective}`,
    "",
    `SUCCESS CRITERIA:\n${criteriaBlock || "(none)"}`,
    "",
    `EVIDENCE LEDGER:\n${evidenceBlock}${evidenceOmittedNote}`,
    "",
    `UNRESOLVED / RECORDED FAILURES:\n${failuresBlock}`,
    "",
    `CHANGED FILES (${ctx.changedFiles.length}):\n${ctx.changedFiles.join("\n") || "(none)"}`,
    "",
    `DIFF (truncated):\n${ctx.diff.slice(0, 12000)}`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * The dedicated repair round-trip: it asks the model to reformat its OWN
 * prior answer, never to re-decide. The original semantic judgment (whatever
 * verdict it already reached) must survive this call unchanged — only the
 * packaging is being fixed.
 */
export function buildReviewRepairMessages(original: ChatMessage[], rawText: string): ChatMessage[] {
  return [
    ...original,
    { role: "assistant", content: rawText.slice(0, 12000) },
    {
      role: "user",
      content: [
        "Your previous answer was not valid machine-readable JSON.",
        "Do NOT reconsider or change your verdict. Re-express the SAME judgment you already gave, as ONLY the JSON object below.",
        '{"verdict":"approved|approved_with_risks|revisions_required|insufficient_evidence",',
        '"criterionJudgments":[{"index":1,"judgment":"satisfied|not_satisfied|unclear","note":"..."}],',
        '"regressionRisks":[],"suspiciousChanges":[],"missingVerification":[],"concerns":[],',
        '"recommendedStatus":"completed|completed_with_reservations|partially_completed|blocked|failed",',
        '"summary":"..."}',
        "No markdown, no code fences, no headings, no commentary, no text before or after the JSON object.",
        "If your prior answer was itself unclear about the verdict, use \"insufficient_evidence\" here — never invent an approval.",
      ].join("\n"),
    },
  ];
}

/**
 * Parse the reviewer's JSON verdict into a MissionReview payload, using the
 * bounded deterministic normalization pipeline (fences, prose, aliases,
 * minor syntax repair, structured-prose fallback). Falls back to a
 * conservative `insufficient_evidence` when no real verdict can be recovered
 * — the reviewer being hard to understand must never become an approval.
 */
export function parseReviewVerdict(text: string, criteria: MissionCriterion[]): ParsedReview {
  return parseReviewVerdictRobust(text, criteria).parsed;
}

/** Same as {@link parseReviewVerdict} but also returns bounded diagnostics
 * (candidate/repair attempts, a hash of the raw text, finish reason) so the
 * caller can log a redacted trail without ever persisting raw provider text. */
export function parseReviewVerdictWithDiagnostics(
  text: string,
  criteria: MissionCriterion[],
  opts: { finishReason?: string | null } = {},
): { parsed: ParsedReview; diagnostics: ReviewParseDiagnostics } {
  return parseReviewVerdictRobust(text, criteria, opts);
}

export function isReviewParseFailure(parsed: ParsedReview): boolean {
  return isReviewParseFailureRobust(parsed);
}

function isNoopReviewListItem(value: string): boolean {
  const text = value.trim();
  return /^(?:none|n\/a|not applicable)\b/i.test(text)
    || /^none expected\b/i.test(text)
    || /^no (?:regression )?(?:risks?|concerns?|issues?|problems?|suspicious changes?|missing verification|unresolved risks?)(?:\b|$)/i.test(text);
}
