import type { MissionRuntimeState } from "@morrow/contracts";
import { MISSION_RUNTIME_TERMINAL_STATES } from "@morrow/contracts";

export const MISSION_RUNTIME_TRANSITIONS: Record<MissionRuntimeState, readonly MissionRuntimeState[]> = {
  created: ["orienting", "cancelled", "abandoned", "superseded"],
  orienting: ["planning", "waiting_for_approval", "recovering", "blocked", "cancelled", "abandoned", "superseded"],
  planning: ["executing", "waiting_for_approval", "recovering", "replanning", "blocked", "cancelled", "abandoned", "superseded"],
  executing: ["validating", "waiting_for_tool", "waiting_for_approval", "recovering", "replanning", "blocked", "cancelled", "abandoned", "superseded"],
  validating: ["completed", "recovering", "replanning", "blocked", "cancelled", "abandoned", "superseded"],
  waiting_for_tool: ["executing", "recovering", "blocked", "cancelled", "abandoned", "superseded"],
  waiting_for_approval: ["planning", "executing", "recovering", "blocked", "cancelled", "abandoned", "superseded"],
  recovering: ["executing", "waiting_for_approval", "replanning", "blocked", "cancelled", "abandoned", "superseded"],
  replanning: ["executing", "waiting_for_approval", "recovering", "blocked", "cancelled", "abandoned", "superseded"],
  blocked: [],
  completed: [],
  cancelled: [],
  abandoned: [],
  superseded: [],
};

export class MissionRuntimeTransitionError extends Error {
  constructor(
    public readonly from: MissionRuntimeState,
    public readonly to: MissionRuntimeState,
    public readonly transitionCause: string,
    message = `Invalid mission runtime transition: ${from} -> ${to} (${transitionCause})`,
  ) {
    super(message);
    this.name = "MissionRuntimeTransitionError";
  }
}

export function canTransitionMissionRuntime(
  from: MissionRuntimeState,
  to: MissionRuntimeState,
  cause: string,
): boolean {
  if ((MISSION_RUNTIME_TERMINAL_STATES as readonly MissionRuntimeState[]).includes(from)) {
    return false;
  }
  if (to === "completed") {
    return from === "validating" && cause === "guardian_passed";
  }
  return MISSION_RUNTIME_TRANSITIONS[from].includes(to);
}

export function assertMissionRuntimeTransition(
  from: MissionRuntimeState,
  to: MissionRuntimeState,
  cause: string,
): void {
  if (canTransitionMissionRuntime(from, to, cause)) return;
  if (to === "completed") {
    throw new MissionRuntimeTransitionError(
      from,
      to,
      cause,
      "Only a passing Guardian decision may complete a durable mission",
    );
  }
  throw new MissionRuntimeTransitionError(from, to, cause);
}
