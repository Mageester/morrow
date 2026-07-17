import { describe, expect, it } from "vitest";
import type { MissionCriterion } from "@morrow/contracts";
import { hashRawReview, isReviewParseFailure, parseReviewVerdictRobust } from "../src/mission/review-normalize.js";

const criteria: MissionCriterion[] = [
  { id: "crit-1", missionId: "m", order: 0, description: "tests pass", state: "verified", verification: { kind: "test", command: "npm test" }, evidenceIds: [], failureReason: null, waiverReason: null, createdAt: "t", updatedAt: "t" },
  { id: "crit-2", missionId: "m", order: 1, description: "diff scoped", state: "verified", verification: { kind: "diff", pathScope: "**" }, evidenceIds: [], failureReason: null, waiverReason: null, createdAt: "t", updatedAt: "t" },
  { id: "crit-3", missionId: "m", order: 2, description: "reviewer approves", state: "pending", verification: { kind: "review" }, evidenceIds: [], failureReason: null, waiverReason: null, createdAt: "t", updatedAt: "t" },
] as unknown as MissionCriterion[];

function approvedFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    verdict: "approved",
    criterionJudgments: [
      { index: 1, judgment: "satisfied", note: "tests pass" },
      { index: 2, judgment: "satisfied", note: "scoped" },
      { index: 3, judgment: "satisfied", note: "approved" },
    ],
    regressionRisks: [],
    suspiciousChanges: [],
    missingVerification: [],
    concerns: [],
    recommendedStatus: "completed",
    summary: "All good.",
    ...overrides,
  });
}

describe("parseReviewVerdictRobust", () => {
  it("parses clean JSON directly (the common case)", () => {
    const { parsed } = parseReviewVerdictRobust(approvedFixture(), criteria);
    expect(parsed.verdict).toBe("approved");
    expect(parsed.recommendedStatus).toBe("completed");
    expect(parsed.criterionJudgments).toHaveLength(3);
  });

  it("extracts valid JSON inside Markdown fences", () => {
    const text = ["Here is my review:", "```json", approvedFixture(), "```"].join("\n");
    const { parsed } = parseReviewVerdictRobust(text, criteria);
    expect(parsed.verdict).toBe("approved");
  });

  it("extracts JSON with prose before and after it", () => {
    const text = `Let me think about this carefully.\n${approvedFixture()}\nThat is my final answer, thank you.`;
    const { parsed } = parseReviewVerdictRobust(text, criteria);
    expect(parsed.verdict).toBe("approved");
  });

  it("normalizes alternate but unambiguous key names", () => {
    const text = JSON.stringify({
      decision: "reject",
      judgments: [{ criterionIndex: 3, result: "fail", reason: "no evidence" }],
      recommendation: "blocked",
      explanation: "Missing verification.",
    });
    const { parsed } = parseReviewVerdictRobust(text, criteria);
    expect(parsed.verdict).toBe("revisions_required");
    expect(parsed.recommendedStatus).toBe("blocked");
  });

  it("normalizes lowercase and uppercase verdict values", () => {
    for (const value of ["APPROVED", "Approved", "approved"]) {
      const { parsed } = parseReviewVerdictRobust(approvedFixture({ verdict: value }), criteria);
      expect(parsed.verdict).toBe("approved");
    }
  });

  it("recovers a clear APPROVE/REJECT judgment expressed in structured prose", () => {
    const approve = "I reviewed everything carefully across several paragraphs.\n\nVerdict: approved\n\nEverything checks out.";
    const { parsed: approved } = parseReviewVerdictRobust(approve, criteria);
    expect(approved.verdict).toBe("approved");

    const reject = "After reviewing the diff at length, my conclusion is below.\n\nVerdict: revisions_required\n\nThe tests do not cover the fix.";
    const { parsed: rejected } = parseReviewVerdictRobust(reject, criteria);
    expect(rejected.verdict).toBe("revisions_required");
  });

  it("never infers approval merely from positive language in surrounding prose", () => {
    const text = "This looks great, fantastic work, everything seems fine and approved in spirit, but I cannot produce the requested JSON right now.";
    const { parsed } = parseReviewVerdictRobust(text, criteria);
    expect(parsed.verdict).toBe("insufficient_evidence");
  });

  it("repairs trailing commas and minor JSON syntax damage", () => {
    const broken = `{"verdict": "approved", "criterionJudgments": [{"index": 1, "judgment": "satisfied", "note": "ok",},], "regressionRisks": [], "suspiciousChanges": [], "missingVerification": [], "concerns": [], "recommendedStatus": "completed", "summary": "ok",}`;
    const { parsed } = parseReviewVerdictRobust(broken, criteria);
    expect(parsed.verdict).toBe("approved");
  });

  it("picks the schema-matching object when multiple JSON objects are present", () => {
    const text = [
      "For reference, here is an EXAMPLE shape (not my answer): {\"foo\": 1, \"bar\": 2}",
      "My actual review:",
      approvedFixture(),
    ].join("\n");
    const { parsed } = parseReviewVerdictRobust(text, criteria);
    expect(parsed.verdict).toBe("approved");
  });

  it("keeps genuinely ambiguous output blocked rather than guessing", () => {
    const text = "I am not fully certain how to characterize this change; there are aspects I cannot verify without more context.";
    const { parsed } = parseReviewVerdictRobust(text, criteria);
    expect(parsed.verdict).toBe("insufficient_evidence");
    expect(isReviewParseFailure(parsed)).toBe(true);
  });

  it("reproduces the actual OpenCode Zen failure shape: reasoning-only truncation with empty content", () => {
    // This is the sanitized shape of the real production failure: a reasoning
    // model exhausts its output budget on hidden chain-of-thought (delivered
    // by the adapter as a separate reasoning channel, never surfaced here)
    // and the visible completion text is empty, with finish_reason "length".
    const { parsed, diagnostics } = parseReviewVerdictRobust("", criteria, { finishReason: "length" });
    expect(parsed.verdict).toBe("insufficient_evidence");
    // Still recognized as a recoverable parse failure (eligible for the bounded
    // repair path upstream) — never silently upgraded to any other verdict.
    expect(isReviewParseFailure(parsed)).toBe(true);
    expect(diagnostics.finishReason).toBe("length");
    expect(diagnostics.rawLength).toBe(0);
  });

  it("computes a stable content hash without ever needing to retain raw text", () => {
    const a = hashRawReview("hello world");
    const b = hashRawReview("hello world");
    const c = hashRawReview("hello world!");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a genuine rejection from the reviewer remains a rejection, never upgraded to approval", () => {
    const text = JSON.stringify({
      verdict: "revisions_required",
      criterionJudgments: [{ index: 1, judgment: "not_satisfied", note: "flaky test" }],
      regressionRisks: ["possible off-by-one"],
      suspiciousChanges: [],
      missingVerification: [],
      concerns: ["needs another pass"],
      recommendedStatus: "partially_completed",
      summary: "Not ready.",
    });
    const { parsed } = parseReviewVerdictRobust(text, criteria);
    expect(parsed.verdict).toBe("revisions_required");
    expect(parsed.regressionRisks).toContain("possible off-by-one");
  });
});
