import type { Mission, MissionResult, MissionReview, MissionStatus } from "@morrow/contracts";
import { gradeMission } from "@morrow/contracts";

/**
 * Build the honest, structured mission result from the ground truth: criterion
 * states, the independent reviewer verdict, recorded failures, and timing. The
 * final status comes from the pure grader — it is never the implementing
 * agent's self-assessment.
 */
export function buildMissionResult(
  mission: Mission,
  opts: {
    review: MissionReview | null;
    changedFiles: string[];
    humanInterventions: number;
    tasksCompleted: number;
    elapsedMs: number | null;
    spentUsd: number | null;
    artifacts?: string[];
  },
): MissionResult {
  const criteria = mission.criteria;
  const verified = criteria.filter((c) => c.state === "verified").length;
  const failed = criteria.filter((c) => c.state === "failed").length;
  const waived = criteria.filter((c) => c.state === "waived").length;
  const unverified = criteria.length - verified - failed - waived;

  const status: MissionStatus = gradeMission(criteria, opts.review?.verdict ?? null);

  // Unresolved risks: reviewer risks + concerns, plus any criterion that is not
  // verified/waived (so the user always sees what was NOT proven).
  const unresolvedRisks: string[] = [];
  if (opts.review) {
    unresolvedRisks.push(...opts.review.regressionRisks, ...opts.review.concerns, ...opts.review.missingVerification);
  }
  for (const c of criteria) {
    if (c.state === "failed") unresolvedRisks.push(`Criterion not met: ${c.description}${c.failureReason ? ` (${c.failureReason})` : ""}`);
    else if (c.state !== "verified" && c.state !== "waived") unresolvedRisks.push(`Criterion unverified: ${c.description}`);
    else if (c.state === "waived") unresolvedRisks.push(`Criterion waived: ${c.description}${c.waiverReason ? ` (${c.waiverReason})` : ""}`);
  }

  const failuresTotal = mission.failures.length;
  const failuresRecovered = mission.failures.filter((f) => f.recovered).length;

  const summary = buildSummary(status, verified, criteria.length, opts.review);

  return {
    status,
    objective: mission.objective,
    criteriaVerified: verified,
    criteriaFailed: failed,
    criteriaUnverified: unverified,
    criteriaWaived: waived,
    criteriaTotal: criteria.length,
    reviewVerdict: opts.review?.verdict ?? null,
    failuresTotal,
    failuresRecovered,
    humanInterventions: opts.humanInterventions,
    tasksCompleted: opts.tasksCompleted,
    changedFiles: opts.changedFiles,
    unresolvedRisks: dedupe(unresolvedRisks),
    artifacts: opts.artifacts ?? [],
    checkpointRefs: mission.checkpoints.map((c) => c.id),
    spentUsd: opts.spentUsd,
    elapsedMs: opts.elapsedMs,
    summary,
  };
}

function buildSummary(status: MissionStatus, verified: number, total: number, review: MissionReview | null): string {
  const grade: Record<MissionStatus, string> = {
    completed: "Completed",
    completed_with_reservations: "Completed with reservations",
    partially_completed: "Partially completed",
    blocked: "Blocked",
    failed: "Failed",
    cancelled: "Cancelled",
    draft: "Draft",
    awaiting_criteria_approval: "Awaiting criteria approval",
    running: "Running",
    reviewing: "Reviewing",
  };
  const parts = [`${grade[status]}. ${verified}/${total} criteria verified.`];
  if (review) parts.push(`Independent review: ${review.verdict.replace(/_/g, " ")}.`);
  return parts.join(" ");
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
