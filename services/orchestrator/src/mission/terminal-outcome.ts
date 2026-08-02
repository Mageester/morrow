import type { MissionRuntimeState, MissionStatus } from "@morrow/contracts";

export const TERMINAL_ENTRY_KINDS = [
  "normal_finalize",
  "user_cancel",
  "controller_exhausted",
  "tool_loop_exhausted",
  "revision_limit",
  "startup_reconciliation",
] as const;

export type TerminalEntryKind = typeof TERMINAL_ENTRY_KINDS[number];

export interface MissionTerminalOutcomeInput {
  kind: TerminalEntryKind;
  reason: string;
  preserveStatus?: MissionStatus;
}

export function terminalDispositionForMission(status: MissionStatus): MissionRuntimeState {
  if (status === "cancelled") return "cancelled";
  if (status === "completed" || status === "completed_with_reservations") return "completed";
  return "blocked";
}
