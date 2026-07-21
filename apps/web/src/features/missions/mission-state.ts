import type { WebMissionUiState } from "@morrow/contracts";

/** Consumer-facing labels for every mission UI state. */
export const missionStateLabels: Record<WebMissionUiState, string> = {
  draft: "Draft",
  needs_input: "Needs input",
  working: "Working",
  reviewing: "Reviewing",
  blocked: "Blocked",
  failed_recoverable: "Failed, recoverable",
  failed: "Failed",
  completed_verified: "Completed and verified",
  completed_with_caveats: "Completed with caveats",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

/** Pill variant for a mission state, matching the StatusPill component. */
export function missionStateVariant(
  state: WebMissionUiState,
): "accent" | "success" | "warning" | "danger" | "neutral" {
  switch (state) {
    case "completed_verified":
    case "completed_with_caveats":
      return "success";
    case "blocked":
    case "needs_input":
    case "failed_recoverable":
      return "warning";
    case "failed":
      return "danger";
    case "working":
    case "reviewing":
      return "accent";
    default:
      return "neutral";
  }
}
