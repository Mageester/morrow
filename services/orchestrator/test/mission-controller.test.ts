import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionRuntimeState } from "@morrow/contracts";
import type { GuardianDecision } from "../src/mission/guardian.js";
import { MissionController, wakeReasonForTask, type ControllerSnapshot } from "../src/mission/controller.js";
import { openDatabase } from "../src/database.js";
import {
  MissionRuntimeLeaseFenceError,
  missionRuntimeRepository,
} from "../src/repositories/mission-runtime.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

const now = "2026-07-16T12:00:00.000Z";

const passedGuardian: GuardianDecision = {
  passed: true,
  missing: [],
  failed: [],
  blocked: [],
  nextActions: [],
  evidenceSnapshot: {
    missionId: "mission-1",
    criteria: { total: 1, satisfied: 1 },
    requirements: { authoritative: 1, satisfied: 1 },
    evidence: { passed: 1, failed: 0, inconclusive: 0 },
    operations: { resolved: 0, unresolved: 0 },
    tasks: { resolved: 1, unresolved: 0 },
    approvals: { resolved: 0, unresolved: 0 },
    validation: { required: ["tests"], completed: ["tests"] },
    changedFiles: [],
  },
};

const failedGuardian: GuardianDecision = {
  ...passedGuardian,
  passed: false,
  missing: [{ kind: "criterion", id: "criterion-1", criterionId: "criterion-1", detail: "Missing evidence." }],
  nextActions: ["validate_criteria"],
};

describe("durable mission controller", () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({
      id: "project-1",
      name: "Project",
      workspacePath: "/workspace",
      createdAt: now,
    });
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project-1", "Durable work", "running", 1, "{}", now, now);
  });
  afterEach(() => db.close());

  function harness(
    state: MissionRuntimeState,
    snapshot: Partial<ControllerSnapshot> = {},
  ) {
    const runtime = missionRuntimeRepository(db);
    runtime.create({ missionId: "mission-1", state, now });
    const fence = runtime.claimLease({
      missionId: "mission-1",
      ownerId: "controller-1",
      now,
      expiresAt: "2026-07-16T12:01:00.000Z",
    })!;
    const current: ControllerSnapshot = {
      tasks: [],
      approvals: [],
      guardianDecision: failedGuardian,
      recovery: null,
      ...snapshot,
    };
    const dispatchWorker = vi.fn((_input: { missionId: string; idempotencyKey: string }) => {
      if (!taskRepository(db).getTaskById("task-1")) {
        taskRepository(db).createTask({
          id: "task-1",
          projectId: "project-1",
          missionId: "mission-1",
          kind: "agent_chat",
          status: "queued",
          createdAt: now,
        });
      }
      return { taskId: "task-1" };
    });
    const finalizeMission = vi.fn();
    const resolveApproval = vi.fn();
    const controller = new MissionController({
      runtime,
      loadSnapshot: () => current,
      dispatchWorker,
      finalizeMission,
      resolveApproval,
      now: () => now,
    });
    return { runtime, fence, current, controller, dispatchWorker, finalizeMission, resolveApproval };
  }

  it.each([
    ["created", "orienting"],
    ["orienting", "planning"],
    ["planning", "executing"],
  ] as const)("advances %s to %s", async (state, expected) => {
    const { controller, fence } = harness(state);
    expect((await controller.tick("mission-1", fence)).runtime.state).toBe(expected);
  });

  it("fences a stale controller that loses its lease after loading the mission snapshot", async () => {
    const original = harness("created");
    const staleController = new MissionController({
      runtime: original.runtime,
      loadSnapshot: () => {
        expect(original.runtime.releaseLease({ missionId: "mission-1", fence: original.fence, now })).toBe(true);
        expect(original.runtime.claimLease({
          missionId: "mission-1",
          ownerId: "controller-2",
          now,
          expiresAt: "2026-07-16T12:02:00.000Z",
        })).toEqual({ ownerId: "controller-2", generation: 2 });
        return original.current;
      },
      dispatchWorker: original.dispatchWorker,
      finalizeMission: original.finalizeMission,
      resolveApproval: original.resolveApproval,
      now: () => now,
    });

    await expect(staleController.tick("mission-1", original.fence))
      .rejects.toThrow(MissionRuntimeLeaseFenceError);
    expect(original.runtime.get("mission-1")?.state).toBe("created");
  });

  it("does not enqueue controller work after its lease is taken over", async () => {
    const original = harness("executing");
    const staleController = new MissionController({
      runtime: original.runtime,
      loadSnapshot: () => {
        original.runtime.releaseLease({ missionId: "mission-1", fence: original.fence, now });
        original.runtime.claimLease({
          missionId: "mission-1",
          ownerId: "controller-2",
          now,
          expiresAt: "2026-07-16T12:02:00.000Z",
        });
        return original.current;
      },
      dispatchWorker: original.dispatchWorker,
      finalizeMission: original.finalizeMission,
      resolveApproval: original.resolveApproval,
      now: () => now,
    });

    await expect(staleController.tick("mission-1", original.fence))
      .rejects.toThrow(MissionRuntimeLeaseFenceError);
    expect(original.runtime.listOperations("mission-1")).toEqual([]);
    expect(original.dispatchWorker).not.toHaveBeenCalled();
  });

  it("moves a completed worker candidate into validation", async () => {
    const { controller, fence } = harness("executing", {
      tasks: [{ id: "task-1", status: "completed" }],
    });
    expect((await controller.tick("mission-1", fence)).runtime.state).toBe("validating");
  });

  it("moves failed validation through recovery and replanning", async () => {
    const validating = harness("validating", { guardianDecision: failedGuardian });
    expect((await validating.controller.tick("mission-1", validating.fence)).runtime.state).toBe("recovering");
  });

  it("selects a recovery before replanning", async () => {
    const { controller, fence } = harness("recovering", {
      recovery: {
        category: "verification_failure",
        diagnosis: "Criterion evidence is missing.",
        failedStrategyFingerprint: "strategy:primary",
        nextStrategyFingerprint: "strategy:repair",
        action: "replan",
        retryCondition: null,
        exhausted: false,
      },
    });
    expect((await controller.tick("mission-1", fence)).runtime.state).toBe("replanning");
  });

  it("only Guardian can complete and finalizes before the terminal transition", async () => {
    const { controller, fence, finalizeMission } = harness("validating", {
      guardianDecision: passedGuardian,
    });
    expect((await controller.tick("mission-1", fence)).runtime.state).toBe("completed");
    expect(finalizeMission).toHaveBeenCalledWith("mission-1");
  });

  it("durably recovers when finalization fails after the Guardian operation starts", async () => {
    const { controller, fence, finalizeMission, runtime } = harness("validating", {
      guardianDecision: passedGuardian,
    });
    finalizeMission.mockRejectedValueOnce(new Error("finalization storage failed"));

    const result = await controller.tick("mission-1", fence);

    expect(result.runtime.state).toBe("recovering");
    expect(runtime.listOperations("mission-1")).toContainEqual(expect.objectContaining({
      kind: "guardian_review",
      status: "failed",
    }));
  });

  it("records provider failure recovery", async () => {
    const failed = harness("executing", {
      tasks: [{ id: "task-1", status: "failed" }],
      recovery: {
        category: "provider_failure",
        diagnosis: "Primary route failed before a tool result.",
        failedStrategyFingerprint: "provider:primary",
        nextStrategyFingerprint: "provider:fallback",
        action: "switch_provider",
        retryCondition: null,
        exhausted: false,
      },
    });
    expect((await failed.controller.tick("mission-1", failed.fence)).runtime.state).toBe("recovering");
    expect(failed.runtime.listRecoveryDecisions("mission-1")).toHaveLength(1);
    expect(failed.runtime.listOperations("mission-1")).toContainEqual(expect.objectContaining({ kind: "recover" }));
  });

  it("does not duplicate a dispatched worker", async () => {
    const dispatched = harness("executing");
    await dispatched.controller.tick("mission-1", dispatched.fence);
    dispatched.current.tasks = [{ id: "task-1", status: "queued" }];
    await dispatched.controller.tick("mission-1", dispatched.fence);
    expect(dispatched.dispatchWorker).toHaveBeenCalledTimes(1);
    expect(dispatched.runtime.listOperations("mission-1").filter((operation) => operation.kind === "dispatch_worker"))
      .toHaveLength(1);
  });

  it("auto-resolves eligible approvals without prompting", async () => {
    const { controller, fence, resolveApproval } = harness("executing", {
      approvals: [{ id: "approval-1", status: "pending", autoResolvable: true }],
    });
    const result = await controller.tick("mission-1", fence);
    expect(result.runtime.state).toBe("executing");
    expect(resolveApproval).toHaveBeenCalledWith("approval-1");
    expect(result.waitingForExternal).toBe(false);
  });

  it("exposes stable task wake reasons", () => {
    expect(wakeReasonForTask("task-1")).toBe("task:task-1:state_changed");
  });
});
