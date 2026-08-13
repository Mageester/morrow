/**
 * The six honest result states from the design mission — no generic
 * "something went wrong", no optimistic copy hiding a permission or
 * verification boundary. `explain()` always answers: what happened, was
 * anything changed, what did Morrow retain, what's the safest next action,
 * and will retrying repeat the same failure.
 */
export type ResultState =
  | "in_progress"
  | "completed"
  | "completed_with_notes"
  | "needs_attention"
  | "blocked"
  | "cancelled"
  | "failed";

export interface ResultStateInfo {
  state: ResultState;
  label: string;
  variant: "neutral" | "accent" | "success" | "warning" | "danger";
  explain: string;
}

const INFO: Record<ResultState, Omit<ResultStateInfo, "state">> = {
  in_progress: {
    label: "In progress",
    variant: "accent",
    explain: "Still running. Nothing has failed yet.",
  },
  completed: {
    label: "Completed",
    variant: "success",
    explain: "Acceptance criteria and required evidence passed.",
  },
  completed_with_notes: {
    label: "Completed with notes",
    variant: "success",
    explain: "Delivered, with non-blocking caveats worth a look.",
  },
  needs_attention: {
    label: "Needs attention",
    variant: "warning",
    explain: "Work exists, but a required verification or approval is still open.",
  },
  blocked: {
    label: "Blocked",
    variant: "danger",
    explain: "A permission, provider, context, or missing-input boundary stopped this.",
  },
  cancelled: {
    label: "Cancelled",
    variant: "neutral",
    explain: "Stopped by you or a parent task. Nothing further will run.",
  },
  failed: {
    label: "Failed",
    variant: "danger",
    explain: "Execution ended without satisfying the contract.",
  },
};

export function resultStateInfo(state: ResultState): ResultStateInfo {
  return { state, ...INFO[state] };
}

export type DelegationStatus =
  | "pending_approval" | "approved" | "rejected" | "running" | "completed" | "failed" | "cancelled";

export function resultStateForDelegation(
  status: DelegationStatus,
  acceptanceCriteriaStatus?: ReadonlyArray<{ met: boolean }>,
): ResultStateInfo {
  switch (status) {
    case "pending_approval":
    case "approved":
      return resultStateInfo("needs_attention");
    case "rejected":
      return resultStateInfo("blocked");
    case "running":
      return resultStateInfo("in_progress");
    case "cancelled":
      return resultStateInfo("cancelled");
    case "failed":
      return resultStateInfo("failed");
    case "completed": {
      const allMet = !acceptanceCriteriaStatus || acceptanceCriteriaStatus.every((c) => c.met);
      return resultStateInfo(allMet ? "completed" : "needs_attention");
    }
  }
}
