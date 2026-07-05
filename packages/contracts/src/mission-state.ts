import type { MissionStatus, MissionCriterion, MissionReviewVerdict } from "./index.js";
import { MISSION_TERMINAL_STATUSES } from "./index.js";

/**
 * Centralized mission state machine. Every valid transition lives here so
 * handlers never invent ad-hoc ones. This is pure and fully unit-testable.
 */
export const MISSION_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  draft: ["awaiting_criteria_approval", "running", "cancelled", "failed"],
  awaiting_criteria_approval: ["running", "cancelled", "failed", "draft"],
  // running can loop back to running (re-execution after review), go to review,
  // or reach a terminal grade directly (e.g. blocked/failed/cancelled).
  running: ["reviewing", "running", "blocked", "failed", "cancelled",
    "completed", "completed_with_reservations", "partially_completed"],
  // reviewing either grades out or bounces back to running for revisions.
  reviewing: ["running", "completed", "completed_with_reservations",
    "partially_completed", "blocked", "failed", "cancelled"],
  completed: [],
  completed_with_reservations: [],
  partially_completed: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

export function isTerminalMissionStatus(status: MissionStatus): boolean {
  return MISSION_TERMINAL_STATUSES.includes(status);
}

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  // Same-state is only valid when the table explicitly lists it (running can
  // re-enter running for a revision cycle); terminal states list nothing.
  return MISSION_TRANSITIONS[from]?.includes(to) ?? false;
}

export class MissionTransitionError extends Error {
  readonly from: MissionStatus;
  readonly to: MissionStatus;
  constructor(from: MissionStatus, to: MissionStatus) {
    super(`Invalid mission transition: ${from} -> ${to}`);
    this.name = "MissionTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransitionMission(from, to)) throw new MissionTransitionError(from, to);
}

/**
 * Honest grading. Turns criterion states plus the independent reviewer verdict
 * into exactly one terminal status. The rules are deliberately strict:
 *
 *  - Any failed criterion that is not waived caps the outcome at partial.
 *  - Insufficient evidence from the reviewer can NEVER become full completion.
 *  - approved_with_risks yields completed_with_reservations even if all criteria
 *    verified, because the reviewer flagged something.
 *  - "verified" requires real evidence; an unverified criterion is not success.
 */
export function gradeMission(
  criteria: Pick<MissionCriterion, "state">[],
  reviewVerdict: MissionReviewVerdict | null,
): MissionStatus {
  const total = criteria.length;
  const verified = criteria.filter((c) => c.state === "verified").length;
  const waived = criteria.filter((c) => c.state === "waived").length;
  const failed = criteria.filter((c) => c.state === "failed").length;
  const unverified = criteria.filter((c) => c.state === "unverified" || c.state === "proposed" || c.state === "approved" || c.state === "in_progress").length;

  // Reviewer explicitly demanded more work or found the evidence lacking.
  if (reviewVerdict === "revisions_required") return "partially_completed";
  if (reviewVerdict === "insufficient_evidence") {
    // Cannot be full success; downgrade based on how much is actually proven.
    return failed > 0 ? "partially_completed" : (verified > 0 ? "partially_completed" : "blocked");
  }

  // No criteria at all is not a success we can vouch for.
  if (total === 0) return "blocked";

  const accountedFor = verified + waived;

  if (failed > 0) {
    // Some concrete criterion failed verification.
    return accountedFor > 0 ? "partially_completed" : "failed";
  }

  if (unverified > 0) {
    // Nothing failed, but not everything is proven.
    return "partially_completed";
  }

  // Every criterion is verified or explicitly waived.
  if (accountedFor === total) {
    if (waived > 0) return "completed_with_reservations";
    if (reviewVerdict === "approved_with_risks") return "completed_with_reservations";
    if (reviewVerdict === "approved") return "completed";
    // All criteria verified but no independent approval on record → be honest
    // that review did not fully sign off.
    return "completed_with_reservations";
  }

  return "partially_completed";
}
