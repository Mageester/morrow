import { describe, expect, it } from "vitest";
import {
  MissionSchema,
  MissionCriterionSchema,
  gradeMission,
  canTransitionMission,
  assertMissionTransition,
  MissionTransitionError,
  isTerminalMissionStatus,
} from "../src/index.js";
import type { MissionCriterionState } from "../src/index.js";

function crit(state: MissionCriterionState) {
  return { state };
}

describe("mission state machine", () => {
  it("allows documented transitions and rejects the rest", () => {
    expect(canTransitionMission("draft", "awaiting_criteria_approval")).toBe(true);
    expect(canTransitionMission("awaiting_criteria_approval", "running")).toBe(true);
    expect(canTransitionMission("running", "reviewing")).toBe(true);
    expect(canTransitionMission("reviewing", "running")).toBe(true);
    expect(canTransitionMission("reviewing", "completed")).toBe(true);
    // Illegal jumps.
    expect(canTransitionMission("draft", "completed")).toBe(false);
    expect(canTransitionMission("completed", "running")).toBe(false);
    expect(canTransitionMission("running", "draft")).toBe(false);
    // No-op transition is not allowed.
    expect(canTransitionMission("running", "running")).toBe(true); // re-execution IS allowed
    expect(canTransitionMission("completed", "completed")).toBe(false);
  });

  it("marks terminal statuses and refuses to leave them", () => {
    for (const s of ["completed", "completed_with_reservations", "partially_completed", "blocked", "failed", "cancelled"] as const) {
      expect(isTerminalMissionStatus(s)).toBe(true);
    }
    expect(isTerminalMissionStatus("running")).toBe(false);
    expect(() => assertMissionTransition("completed", "running")).toThrow(MissionTransitionError);
  });
});

describe("gradeMission — honest completion", () => {
  it("all verified + reviewer approved => completed", () => {
    expect(gradeMission([crit("verified"), crit("verified")], "approved")).toBe("completed");
  });

  it("all verified but reviewer approved_with_risks => completed_with_reservations", () => {
    expect(gradeMission([crit("verified"), crit("verified")], "approved_with_risks")).toBe("completed_with_reservations");
  });

  it("all verified but no review on record => completed_with_reservations (not full)", () => {
    expect(gradeMission([crit("verified")], null)).toBe("completed_with_reservations");
  });

  it("a waived criterion caps at completed_with_reservations", () => {
    expect(gradeMission([crit("verified"), crit("waived")], "approved")).toBe("completed_with_reservations");
  });

  it("a failed criterion cannot be full success", () => {
    expect(gradeMission([crit("verified"), crit("failed")], "approved")).toBe("partially_completed");
    expect(gradeMission([crit("failed")], "approved")).toBe("failed");
  });

  it("insufficient evidence can never become completed", () => {
    expect(gradeMission([crit("verified"), crit("verified")], "insufficient_evidence")).toBe("partially_completed");
    expect(gradeMission([crit("unverified")], "insufficient_evidence")).toBe("blocked");
  });

  it("revisions_required grades partial", () => {
    expect(gradeMission([crit("verified")], "revisions_required")).toBe("partially_completed");
  });

  it("unverified criteria prevent completion", () => {
    expect(gradeMission([crit("verified"), crit("unverified")], "approved")).toBe("partially_completed");
  });

  it("no criteria is blocked, not success", () => {
    expect(gradeMission([], "approved")).toBe("blocked");
  });
});

describe("MissionSchema shape", () => {
  it("parses a minimal mission with defaults", () => {
    const now = new Date().toISOString();
    const mission = MissionSchema.parse({
      version: 1,
      id: "m1",
      projectId: "p1",
      objective: "Repair the game",
      status: "draft",
      budget: {},
      createdAt: now,
      updatedAt: now,
    });
    expect(mission.criteria).toEqual([]);
    expect(mission.autoApprove).toBe(false);
    expect(mission.budget.maxReviewCycles).toBe(2);
    expect(mission.conversationId).toBeNull();
  });

  it("validates a criterion with a verification strategy", () => {
    const now = new Date().toISOString();
    const c = MissionCriterionSchema.parse({
      id: "c1", missionId: "m1", order: 0,
      description: "JS syntax is valid",
      state: "proposed",
      verification: { kind: "command", command: "node --check game.js", expectExitCode: 0 },
      createdAt: now, updatedAt: now,
    });
    expect(c.evidenceIds).toEqual([]);
    expect(c.verification.kind).toBe("command");
  });
});
