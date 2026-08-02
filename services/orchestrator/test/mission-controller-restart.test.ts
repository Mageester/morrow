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
import { missionsRepository } from "../src/repositories/missions.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { MissionService } from "../src/mission/service.js";

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

    const summary = await reconcileMissionsOnStartup({
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

  it("reconciles a terminal mission after the marker committed before runtime transition", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-controller-marker-crash-"));
    roots.push(root);
    const db = openDatabase(":memory:");
    const timestamp = "2026-07-16T12:00:00.000Z";
    projectRepository(db).createProject({ id: "project-1", name: "Project", workspacePath: root, createdAt: timestamp });
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project-1", "Recover the terminal marker", "blocked", 1, "{}", timestamp, timestamp);
    taskRepository(db).createTask({
      id: "task-1", projectId: "project-1", missionId: "mission-1", kind: "agent_chat", status: "running", createdAt: timestamp,
    });
    const service = new MissionService({
      repo: missionsRepository(db),
      getWorkspacePath: () => root,
      backupDir: join(root, "backups"),
      now: () => timestamp,
      serviceInstanceId: "marker-crash-test",
    });
    await service.concludeTerminalOutcome("mission-1", {
      kind: "controller_exhausted",
      reason: "Controller exhausted before runtime transition.",
      preserveStatus: "blocked",
    });

    const runtime = missionRuntimeRepository(db);
    runtime.create({ missionId: "mission-1", state: "executing", now: timestamp });
    db.prepare("UPDATE mission_runtime SET active_task_id=? WHERE mission_id=?").run("task-1", "mission-1");
    const dispatchWorker = vi.fn(() => ({ taskId: "task-duplicate" }));
    const cancelTask = vi.fn();
    const loadSnapshot = (): ControllerSnapshot => ({
      tasks: [{ id: "task-1", status: "running" }],
      approvals: [],
      guardianDecision: guardianPassed,
      recovery: null,
      missionStatus: "blocked",
      terminalOutcomeRecorded: true,
      terminalOutcomeKind: "controller_exhausted",
      terminalOutcomeReason: "Controller exhausted before runtime transition.",
    });
    const controller = new MissionController({
      runtime,
      loadSnapshot,
      dispatchWorker,
      finalizeMission: vi.fn(),
      deferTerminalOutcomes: true,
      now: () => timestamp,
    });
    const closeout = vi.fn((missionId: string, input: Parameters<MissionService["concludeTerminalOutcome"]>[1]) =>
      service.concludeTerminalOutcome(missionId, input));
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller,
      taskRunner: {
        isActive: () => false,
        waitFor: async () => undefined,
        cancel: cancelTask,
      },
      ownerId: "process-after-marker-crash",
      concludeTerminalOutcome: closeout,
      now: () => timestamp,
    });

    const summary = await reconcileMissionsOnStartup({
      db,
      runner: { run: vi.fn(), isActive: () => false },
      controllerRunner,
      now: () => timestamp,
    });
    await controllerRunner.waitFor("mission-1");

    expect(summary.missionsResumed).toBe(1);
    expect(runtime.get("mission-1")?.state).toBe("blocked");
    expect(cancelTask).toHaveBeenCalledWith("task-1", "mission_terminal");
    expect(closeout).toHaveBeenCalledTimes(1);
    expect(dispatchWorker).not.toHaveBeenCalled();
    expect(missionsRepository(db).listEvents("mission-1").filter((event) => event.type === "mission.terminal_outcome_recorded"))
      .toHaveLength(1);
    db.close();
  });

  it("waits for terminal-runtime startup reconciliation before returning", async () => {
    const db = openDatabase(":memory:");
    const timestamp = "2026-07-16T12:00:00.000Z";
    projectRepository(db).createProject({ id: "project-1", name: "Project", workspacePath: ".", createdAt: timestamp });
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project-1", "Await startup reconciliation", "cancelled", 1, "{}", timestamp, timestamp);
    missionRuntimeRepository(db).create({ missionId: "mission-1", state: "cancelled", now: timestamp });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    const reconcileTerminalOutcome = vi.fn(async () => {
      await gate;
      finished = true;
    });
    const controllerRunner = {
      run: vi.fn(),
      wake: vi.fn(),
      isActive: vi.fn(() => false),
      reconcileTerminalOutcome,
    };

    let startupCompleted = false;
    const startup = Promise.resolve(reconcileMissionsOnStartup({
      db,
      runner: { run: vi.fn(), isActive: () => false },
      controllerRunner,
      now: () => timestamp,
    })).then((result) => {
      startupCompleted = true;
      return result;
    });
    await Promise.resolve();
    expect(startupCompleted).toBe(false);
    expect(finished).toBe(false);
    release();
    const summary = await startup;

    expect(summary.missionsResumed).toBe(1);
    expect(finished).toBe(true);
    expect(reconcileTerminalOutcome).toHaveBeenCalledWith("mission-1", expect.objectContaining({
      kind: "startup_reconciliation",
      preserveStatus: "cancelled",
    }));
    db.close();
  });

  it.each([
    { missionStatus: "cancelled" as const, runtimeState: "cancelled" as const },
    { missionStatus: "completed" as const, runtimeState: "completed" as const },
    { missionStatus: "blocked" as const, runtimeState: "blocked" as const },
  ])("accepts the shared terminal disposition for $missionStatus runtime", async ({ missionStatus, runtimeState }) => {
    const db = openDatabase(":memory:");
    const timestamp = "2026-07-16T12:00:00.000Z";
    projectRepository(db).createProject({ id: "project-1", name: "Project", workspacePath: ".", createdAt: timestamp });
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project-1", "Check terminal disposition", missionStatus, 1, "{}", timestamp, timestamp);
    const runtime = missionRuntimeRepository(db);
    runtime.create({ missionId: "mission-1", state: runtimeState, now: timestamp });
    const concludeTerminalOutcome = vi.fn(async () => ({ status: missionStatus }));
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {} as never,
      taskRunner: { isActive: () => false, waitFor: async () => undefined },
      ownerId: "terminal-disposition-test",
      concludeTerminalOutcome,
      now: () => timestamp,
    });

    await controllerRunner.reconcileTerminalOutcome("mission-1", {
      kind: "startup_reconciliation",
      reason: "Check terminal disposition.",
      preserveStatus: missionStatus,
    });

    expect(concludeTerminalOutcome).toHaveBeenCalledTimes(1);
    expect(runtime.get("mission-1")?.state).toBe(runtimeState);
    db.close();
  });

  it("rejects a contradictory terminal runtime during startup reconciliation", async () => {
    const db = openDatabase(":memory:");
    const timestamp = "2026-07-16T12:00:00.000Z";
    projectRepository(db).createProject({ id: "project-1", name: "Project", workspacePath: ".", createdAt: timestamp });
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project-1", "Reject contradiction", "blocked", 1, "{}", timestamp, timestamp);
    const runtime = missionRuntimeRepository(db);
    runtime.create({ missionId: "mission-1", state: "completed", now: timestamp });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {} as never,
      taskRunner: { isActive: () => false, waitFor: async () => undefined },
      ownerId: "terminal-contradiction-test",
      concludeTerminalOutcome: async () => ({ status: "blocked" }),
      now: () => timestamp,
    });

    await expect(controllerRunner.reconcileTerminalOutcome("mission-1", {
      kind: "startup_reconciliation",
      reason: "Reject contradiction.",
      preserveStatus: "blocked",
    })).rejects.toMatchObject({ code: "finalization_integrity_error" });
    db.close();
  });

  it("rejects a contradictory terminal runtime even when its outcome marker exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-terminal-marker-contradiction-"));
    roots.push(root);
    const db = openDatabase(":memory:");
    const timestamp = "2026-07-16T12:00:00.000Z";
    projectRepository(db).createProject({ id: "project-1", name: "Project", workspacePath: root, createdAt: timestamp });
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project-1", "Reject marked contradiction", "blocked", 1, "{}", timestamp, timestamp);
    const service = new MissionService({
      repo: missionsRepository(db),
      getWorkspacePath: () => root,
      backupDir: join(root, "backups"),
      now: () => timestamp,
      serviceInstanceId: "marked-contradiction-test",
    });
    await service.concludeTerminalOutcome("mission-1", {
      kind: "controller_exhausted",
      reason: "Persisted blocked outcome.",
      preserveStatus: "blocked",
    });
    const runtime = missionRuntimeRepository(db);
    runtime.create({ missionId: "mission-1", state: "completed", now: timestamp });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {} as never,
      taskRunner: { isActive: () => false, waitFor: async () => undefined },
      ownerId: "marked-contradiction-controller",
      concludeTerminalOutcome: (missionId, input) => service.concludeTerminalOutcome(missionId, input),
      now: () => timestamp,
    });

    await expect(reconcileMissionsOnStartup({
      db,
      runner: { run: vi.fn(), isActive: () => false },
      controllerRunner,
      now: () => timestamp,
    })).rejects.toMatchObject({ code: "finalization_integrity_error" });
    db.close();
  });

  it("stops late external-task wakes without cancelling durable worker state", async () => {
    let settleTask!: () => void;
    const taskSettled = new Promise<void>((resolve) => {
      settleTask = resolve;
    });
    const tick = vi.fn(async () => ({
      runtime: { activeTaskId: "task-1" },
      action: "wait_for_worker",
      immediate: false,
      waitingForExternal: true,
    }));
    const claimLease = vi.fn(() => ({ ownerId: "controller-test", generation: 1 }));
    const cancelTask = vi.fn();
    const controllerRunner = new MissionControllerRunner({
      runtime: {
        claimLease,
        releaseLease: vi.fn(),
        renewLease: vi.fn(),
        get: vi.fn(() => ({ activeTaskId: "task-1" })),
      } as never,
      controller: { tick } as never,
      taskRunner: {
        isActive: () => true,
        waitFor: () => taskSettled,
        cancel: cancelTask,
      },
      ownerId: "controller-test",
      now: () => "2026-07-16T12:00:00.000Z",
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");
    await controllerRunner.stop("mission-1");
    settleTask();
    await taskSettled;
    await Promise.resolve();
    await controllerRunner.waitFor("mission-1");

    expect(cancelTask).not.toHaveBeenCalled();
    expect(claimLease).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(controllerRunner.isActive("mission-1")).toBe(false);
  });
});
