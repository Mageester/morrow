import { describe, expect, it } from "vitest";
import {
  MISSION_RUNTIME_TERMINAL_STATES,
  MissionRuntimeSchema,
  MissionRuntimeTransitionSchema,
} from "@morrow/contracts";
import {
  MISSION_RUNTIME_USER_RETRY_CAUSE,
  MissionRuntimeTransitionError,
  assertMissionRuntimeTransition,
  canTransitionMissionRuntime,
} from "../src/mission/runtime-state.js";

describe("durable mission runtime state", () => {
  it("does not let a provider or worker declare durable completion", () => {
    expect(() => assertMissionRuntimeTransition("executing", "completed", "worker_completed"))
      .toThrow(/Guardian/i);
    expect(() => assertMissionRuntimeTransition("validating", "completed", "guardian_passed"))
      .not.toThrow();
  });

  it("rejects exits from every terminal runtime state", () => {
    for (const terminal of MISSION_RUNTIME_TERMINAL_STATES) {
      expect(canTransitionMissionRuntime(terminal, "recovering", "manual_resume")).toBe(false);
      expect(() => assertMissionRuntimeTransition(terminal, "recovering", "manual_resume"))
        .toThrow(MissionRuntimeTransitionError);
    }
  });

  it("keeps a blocked runtime terminal except for an explicit user retry into replanning", () => {
    // The single sanctioned escape from blocked: a human asking to try again.
    expect(
      canTransitionMissionRuntime("blocked", "replanning", MISSION_RUNTIME_USER_RETRY_CAUSE),
    ).toBe(true);
    expect(() =>
      assertMissionRuntimeTransition("blocked", "replanning", MISSION_RUNTIME_USER_RETRY_CAUSE),
    ).not.toThrow();

    // Every other target or cause is rejected — nothing silently resurrects a
    // blocked mission, and it cannot skip replanning straight into execution.
    expect(
      canTransitionMissionRuntime("blocked", "executing", MISSION_RUNTIME_USER_RETRY_CAUSE),
    ).toBe(false);
    expect(
      canTransitionMissionRuntime("blocked", "replanning", "controller_wake"),
    ).toBe(false);
    expect(canTransitionMissionRuntime("blocked", "recovering", "manual_resume")).toBe(false);
    expect(() =>
      assertMissionRuntimeTransition("blocked", "executing", MISSION_RUNTIME_USER_RETRY_CAUSE),
    ).toThrow(MissionRuntimeTransitionError);
  });

  it("allows waiting missions to resume through the controller", () => {
    expect(canTransitionMissionRuntime("waiting_for_tool", "executing", "tool_completed")).toBe(true);
    expect(canTransitionMissionRuntime("waiting_for_approval", "executing", "approval_resolved")).toBe(true);
    expect(canTransitionMissionRuntime("recovering", "replanning", "recovery_selected")).toBe(true);
  });

  it("validates append-only transition records", () => {
    const now = new Date().toISOString();
    const parsed = MissionRuntimeTransitionSchema.parse({
      version: 1,
      id: "transition-1",
      missionId: "mission-1",
      sequence: 1,
      from: "created",
      to: "orienting",
      cause: "controller_started",
      actor: "controller",
      details: {},
      createdAt: now,
    });

    expect(parsed.sequence).toBe(1);
    expect(parsed.to).toBe("orienting");
  });

  it("validates a live runtime with an unowned controller lease", () => {
    const now = new Date().toISOString();
    const parsed = MissionRuntimeSchema.parse({
      version: 1,
      missionId: "mission-1",
      state: "executing",
      finalDisposition: null,
      activeOperationId: null,
      activeTaskId: "task-1",
      wakeReason: "task_dispatched",
      transitionSequence: 3,
      operationSequence: 2,
      leaseOwner: null,
      leaseGeneration: 0,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });

    expect(parsed.state).toBe("executing");
    expect(parsed.finalDisposition).toBeNull();
  });
});
