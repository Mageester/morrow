import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuardianDecision } from "../src/mission/guardian.js";
import { MissionController, type ControllerSnapshot } from "../src/mission/controller.js";
import { MissionControllerRunner } from "../src/mission/controller-runner.js";
import { openDatabase } from "../src/database.js";
import { reconcileMissionsOnStartup } from "../src/recovery.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const guardianPassed: GuardianDecision = {
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
    operations: { resolved: 1, unresolved: 0 },
    tasks: { resolved: 1, unresolved: 0 },
    approvals: { resolved: 0, unresolved: 0 },
    validation: { required: ["tests"], completed: ["tests"] },
    changedFiles: [],
  },
};

describe("mission controller restart continuity", () => {
  it("reclaims the same mission and skips a completed dispatch after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-controller-restart-"));
    roots.push(root);
    const dbPath = join(root, "morrow.db");
    const firstDb = openDatabase(dbPath);
    projectRepository(firstDb).createProject({
      id: "project-1",
      name: "Project",
      workspacePath: root,
      createdAt: "2026-07-16T12:00:00.000Z",
    });
    firstDb.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project-1", "Survive restart", "running", 1, "{}", "2026-07-16T12:00:00.000Z", "2026-07-16T12:00:00.000Z");
    taskRepository(firstDb).createTask({
      id: "task-1",
      projectId: "project-1",
      missionId: "mission-1",
      kind: "agent_chat",
      status: "completed",
      createdAt: "2026-07-16T12:00:00.000Z",
    });
    const firstRuntime = missionRuntimeRepository(firstDb);
    firstRuntime.create({ missionId: "mission-1", state: "executing", now: "2026-07-16T12:00:00.000Z" });
    const firstFence = firstRuntime.claimLease({
      missionId: "mission-1",
      ownerId: "process-1",
      now: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-16T12:01:00.000Z",
    })!;
    const dispatched = firstRuntime.enqueueOperation({
      id: "operation-dispatch",
      missionId: "mission-1",
      idempotencyKey: "dispatch:mission-1:phase:0",
      kind: "dispatch_worker",
      strategyFingerprint: "worker:primary",
      input: { missionId: "mission-1" },
      fence: firstFence,
      now: "2026-07-16T12:00:00.000Z",
    });
    firstRuntime.startOperation({ missionId: "mission-1", operationId: dispatched.id, fence: firstFence, now: "2026-07-16T12:00:00.000Z" });
    firstRuntime.completeOperation({
      missionId: "mission-1",
      operationId: dispatched.id,
      fence: firstFence,
      result: { taskId: "task-1" },
      effectEvidenceIds: [],
      now: "2026-07-16T12:00:00.000Z",
    });
    firstRuntime.setActiveTask({ missionId: "mission-1", taskId: "task-1", fence: firstFence, now: "2026-07-16T12:00:00.000Z" });
    firstDb.close();

    const secondDb = openDatabase(dbPath);
    const runtime = missionRuntimeRepository(secondDb);
    const dispatchWorker = vi.fn(() => ({ taskId: "task-duplicate" }));
    const snapshot: ControllerSnapshot = {
      tasks: [{ id: "task-1", status: "completed" }],
      approvals: [],
      guardianDecision: guardianPassed,
      recovery: null,
    };
    const controller = new MissionController({
      runtime,
      loadSnapshot: () => snapshot,
      dispatchWorker,
      finalizeMission: vi.fn(),
      now: () => "2026-07-16T12:02:00.000Z",
    });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller,
      taskRunner: { isActive: () => false, waitFor: async () => undefined },
      ownerId: "process-2",
      now: () => "2026-07-16T12:02:00.000Z",
      leaseMs: 60_000,
    });

    const summary = reconcileMissionsOnStartup({
      db: secondDb,
      runner: { run: vi.fn(), isActive: () => false },
      controllerRunner,
      now: () => "2026-07-16T12:02:00.000Z",
    });
    await controllerRunner.waitFor("mission-1");

    expect(summary.missionsResumed).toBe(1);
    expect(runtime.get("mission-1")?.state).toBe("completed");
    expect(runtime.listOperations("mission-1").filter((operation) => operation.kind === "dispatch_worker"))
      .toHaveLength(1);
    expect(dispatchWorker).not.toHaveBeenCalled();
    secondDb.close();
  });
});
