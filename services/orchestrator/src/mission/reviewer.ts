import type {
  Mission, MissionCriterion, MissionEvidence, MissionFailure, MissionReview,
  MissionReviewVerdict, MissionStatus,
} from "@morrow/contracts";
import type { ChatMessage } from "../provider/base.js";

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
export function buildReviewMessages(ctx: ReviewContext): ChatMessage[] {
  const criteriaBlock = ctx.criteria.map((c, i) =>
    `${i + 1}. [${c.state}] ${c.description}\n   verification: ${c.verification.kind}${c.verification.command ? ` (\`${c.verification.command}\`)` : ""}\n   evidence: ${c.evidenceIds.length} record(s)`,
  ).join("\n");

  const evidenceBlock = ctx.evidence.map((e) =>
    `- [${e.status}] ${e.type}: ${e.summary}${e.exitCode !== null ? ` (exit ${e.exitCode})` : ""}`,
  ).join("\n") || "(no evidence recorded)";

  const failuresBlock = ctx.failures.length
    ? ctx.failures.map((f) => `- [${f.category}] ${f.operation}: ${f.recovered ? "recovered" : "UNRESOLVED"}`).join("\n")
    : "(no failures recorded)";

  const system = [
    "You are an INDEPENDENT reviewer auditing whether a coding mission actually met its success criteria.",
    "You did NOT do the work and you must not assume it was done correctly.",
    "Judge ONLY from the objective, the approved criteria, the concrete evidence, the diff, and unresolved failures below.",
    "Do not accept any claim of success that is not backed by evidence in this message.",
    "A criterion with no passing evidence is NOT satisfied. Flag suspicious or unrelated changes.",
    "",
    "Return ONLY a JSON object with this exact shape:",
    '{"verdict": "approved"|"approved_with_risks"|"revisions_required"|"insufficient_evidence",',
    ' "criterionJudgments": [{"index": number, "judgment": "satisfied"|"not_satisfied"|"unclear", "note": string}],',
    ' "regressionRisks": string[], "suspiciousChanges": string[], "missingVerification": string[],',
    ' "concerns": string[], "recommendedStatus": "completed"|"completed_with_reservations"|"partially_completed"|"blocked"|"failed",',
    ' "summary": string}',
    "Use 'approved' only when every criterion is satisfied by evidence with no material risk.",
    "Use 'insufficient_evidence' when criteria are claimed done but evidence is missing.",
  ].join("\n");

  const user = [
    `OBJECTIVE:\n${ctx.objective}`,
    "",
    `SUCCESS CRITERIA:\n${criteriaBlock || "(none)"}`,
    "",
    `EVIDENCE LEDGER:\n${evidenceBlock}`,
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

export function buildReviewRepairMessages(original: ChatMessage[], rawText: string): ChatMessage[] {
  return [
    ...original,
    { role: "assistant", content: rawText.slice(0, 12000) },
    {
      role: "user",
      content: [
        "Your previous answer was not valid machine-readable JSON.",
        "Convert your review into ONLY the JSON object requested in the system message.",
        "Do not add markdown, prose, code fences, headings, or commentary.",
        "If the evidence is insufficient, return verdict \"insufficient_evidence\" in that JSON shape.",
      ].join("\n"),
    },
  ];
}

const VERDICTS: MissionReviewVerdict[] = ["approved", "approved_with_risks", "revisions_required", "insufficient_evidence"];
const STATUSES: MissionStatus[] = ["completed", "completed_with_reservations", "partially_completed", "blocked", "failed"];

/**
 * Parse the reviewer's JSON verdict into a MissionReview payload. Tolerant of
 * fences/prose. Falls back to a conservative `insufficient_evidence` when the
 * output cannot be parsed — the reviewer refusing to be understood must never
 * become an approval.
 */
export function parseReviewVerdict(
  text: string,
  criteria: MissionCriterion[],
): Omit<MissionReview, "id" | "missionId" | "createdAt" | "reviewerProvider" | "reviewerModel"> {
  const json = extractJsonObject(text);
  let raw: any = null;
  if (json) { try { raw = JSON.parse(json); } catch { raw = null; } }
  if (!raw || typeof raw !== "object") {
    return {
      verdict: "insufficient_evidence",
      criterionJudgments: [],
      regressionRisks: [],
      suspiciousChanges: [],
      missingVerification: ["Reviewer output could not be parsed into a structured verdict"],
      concerns: ["Reviewer did not return a usable verdict"],
      recommendedStatus: "partially_completed",
      summary: "Reviewer output was not machine-readable; treated as insufficient evidence.",
    };
  }
  const verdict: MissionReviewVerdict = VERDICTS.includes(raw.verdict) ? raw.verdict : "insufficient_evidence";
  const recommendedStatus: MissionStatus = STATUSES.includes(raw.recommendedStatus) ? raw.recommendedStatus : "partially_completed";
  const criterionJudgments = Array.isArray(raw.criterionJudgments)
    ? raw.criterionJudgments.map((j: any) => {
        const idx = typeof j.index === "number" ? j.index - 1 : -1;
        const criterionId = criteria[idx]?.id ?? (typeof j.criterionId === "string" ? j.criterionId : "");
        return {
          criterionId,
          judgment: (["satisfied", "not_satisfied", "unclear"].includes(j.judgment) ? j.judgment : "unclear") as "satisfied" | "not_satisfied" | "unclear",
          note: typeof j.note === "string" ? j.note.slice(0, 1000) : "",
        };
      }).filter((j: any) => j.criterionId)
    : [];
  const strArr = (v: unknown): string[] => Array.isArray(v)
    ? v.filter((x) => typeof x === "string")
        .map((x) => (x as string).trim().slice(0, 500))
        .filter((x) => x && !isNoopReviewListItem(x))
        .slice(0, 20)
    : [];
  return {
    verdict,
    criterionJudgments,
    regressionRisks: strArr(raw.regressionRisks),
    suspiciousChanges: strArr(raw.suspiciousChanges),
    missingVerification: strArr(raw.missingVerification),
    concerns: strArr(raw.concerns),
    recommendedStatus,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 4000) : "",
  };
}

export function isReviewParseFailure(
  parsed: Omit<MissionReview, "id" | "missionId" | "createdAt" | "reviewerProvider" | "reviewerModel">,
): boolean {
  return parsed.verdict === "insufficient_evidence"
    && parsed.summary === "Reviewer output was not machine-readable; treated as insufficient evidence."
    && parsed.missingVerification.includes("Reviewer output could not be parsed into a structured verdict");
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

function isNoopReviewListItem(value: string): boolean {
  const text = value.trim();
  return /^(?:none|n\/a|not applicable)\b/i.test(text)
    || /^none expected\b/i.test(text)
    || /^no (?:regression )?(?:risks?|concerns?|issues?|problems?|suspicious changes?|missing verification|unresolved risks?)(?:\b|$)/i.test(text);
}
