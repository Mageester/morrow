import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { MissionController, type ControllerSnapshot } from "../src/mission/controller.js";
import { MissionControllerRunner } from "../src/mission/controller-runner.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

const now = "2026-08-27T12:00:00.000Z";
const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(state: "planning" | "executing" | "validating" | "blocked" | "orienting" | "waiting_for_approval" = "executing") {
  const db = openDatabase(":memory:");
  databases.push(db);
  projectRepository(db).createProject({ id: "project-1", name: "Project", workspacePath: "/workspace", createdAt: now });
  db.prepare(`INSERT INTO missions
    (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run("mission-1", 1, "project-1", "Durable controller failure", "running", 1, "{}", now, now);
  const runtime = missionRuntimeRepository(db);
  runtime.create({ missionId: "mission-1", state, now });
  return { db, runtime };
}

const taskRunner = {
  isActive: () => false,
  waitFor: async () => undefined,
};

const guardianPassed: ControllerSnapshot["guardianDecision"] = {
  passed: true,
  missing: [],
  failed: [],
  blocked: [],
  nextActions: [],
  evidenceSnapshot: {
    missionId: "mission-1",
    criteria: { total: 0, satisfied: 0 },
    requirements: { authoritative: 0, satisfied: 0 },
    evidence: { passed: 0, failed: 0, inconclusive: 0 },
    operations: { resolved: 0, unresolved: 0 },
    tasks: { resolved: 0, unresolved: 0 },
    approvals: { resolved: 0, unresolved: 0 },
    validation: { required: [], completed: [] },
    changedFiles: [],
  },
};

describe("mission controller runner failure recovery", () => {
  it("does not lose a non-fencing drive rejection", async () => {
    const { runtime } = fixture();
    const originalClaimLease = runtime.claimLease.bind(runtime);
    let attempts = 0;
    vi.spyOn(runtime, "claimLease").mockImplementation((input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("controller drive failed before fencing");
      return originalClaimLease(input);
    });
    const tick = vi.fn(async () => ({
      runtime: runtime.get("mission-1")!,
      action: "wait",
      immediate: false,
      waitingForExternal: false,
    }));
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: { tick },
      taskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(attempts).toBe(2);
    expect(runtime.listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({
      category: "process_interruption",
      exhausted: false,
    }));
    expect(runtime.get("mission-1")?.state).not.toBe("completed");
  });

  it("reclaims a lease before handling an external wait rejection", async () => {
    const { runtime } = fixture();
    const claimLease = vi.spyOn(runtime, "claimLease");
    let active = true;
    const waitingTaskRunner = {
      isActive: () => active,
      waitFor: async () => {
        active = false;
        throw new Error("worker wait failed");
      },
    };
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {
        tick: vi.fn(async () => ({
          runtime: { ...runtime.get("mission-1")!, activeTaskId: "task-1" },
          action: "wait:task-1",
          immediate: false,
          waitingForExternal: true,
        })),
      },
      taskRunner: waitingTaskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");
    await vi.waitFor(() => expect(runtime.listRecoveryDecisions("mission-1")).toHaveLength(1));
    await controllerRunner.waitFor("mission-1");

    expect(runtime.get("mission-1")?.state).toBe("recovering");
    expect(runtime.listTransitions("mission-1")).toHaveLength(1);
    expect(runtime.listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({
      category: "process_interruption",
      exhausted: false,
      operationId: expect.any(String),
    }));
    expect(claimLease).toHaveBeenCalledTimes(3);
  });

  it("rejects mission wait when detached worker-failure classification cannot persist", async () => {
    const { runtime } = fixture();
    let rejectWait!: (error: Error) => void;
    const waitingTaskRunner = {
      isActive: () => true,
      waitFor: () => new Promise<void>((_resolve, reject) => { rejectWait = reject; }),
    };
    const recordRecovery = vi.spyOn(runtime, "recordRecovery").mockImplementation(() => {
      throw new Error("callback recovery write unavailable");
    });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {
        tick: vi.fn(async () => ({
          runtime: { ...runtime.get("mission-1")!, activeTaskId: "task-1" },
          action: "wait:task-1",
          immediate: false,
          waitingForExternal: true,
        })),
      },
      taskRunner: waitingTaskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await vi.waitFor(() => expect(controllerRunner.isActive("mission-1")).toBe(false));
    rejectWait(new Error("worker wait failed"));

    await expect(controllerRunner.waitFor("mission-1")).rejects.toThrow("callback recovery write unavailable");
    expect(recordRecovery).toHaveBeenCalled();
  });

  it("self-cleans a settled detached wait when no caller observes it", async () => {
    const { runtime } = fixture();
    let resolveWait!: () => void;
    const waitingTaskRunner = {
      isActive: () => true,
      waitFor: () => new Promise<void>((resolve) => { resolveWait = resolve; }),
    };
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: { tick: vi.fn(async () => ({
        runtime: { ...runtime.get("mission-1")!, activeTaskId: "task-1" },
        action: "wait:task-1", immediate: false, waitingForExternal: true,
      })) },
      taskRunner: waitingTaskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.stop("mission-1");
    resolveWait();
    await vi.waitFor(() => expect((controllerRunner as unknown as { detachedPromises: Map<string, unknown> }).detachedPromises.size).toBe(0));

    expect((controllerRunner as unknown as { detachedPromises: Map<string, unknown> }).detachedPromises.size).toBe(0);
  });

  it("waits for a detached promise registered while the driver is active", async () => {
    const { runtime } = fixture();
    let resolveWait!: () => void;
    let active = true;
    let releaseTick!: () => void;
    const tickGate = new Promise<void>((resolve) => { releaseTick = resolve; });
    const waitingTaskRunner = {
      isActive: () => active,
      waitFor: () => new Promise<void>((resolve) => { resolveWait = resolve; }),
    };
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: { tick: vi.fn(async () => {
        await tickGate;
        return {
          runtime: { ...runtime.get("mission-1")!, activeTaskId: "task-1" },
          action: "wait:task-1", immediate: false, waitingForExternal: true,
        };
      }) },
      taskRunner: waitingTaskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    const waiting = controllerRunner.waitFor("mission-1");
    let settled = false;
    void waiting.then(() => { settled = true; });
    releaseTick();
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.waitFor(() => expect((controllerRunner as unknown as {
      detachedPromises: Map<string, unknown>;
    }).detachedPromises.size).toBe(1));
    await vi.waitFor(() => expect(controllerRunner.isActive("mission-1")).toBe(false));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    active = false;
    resolveWait();
    await waiting;
  });

  it("adopts the awaited generation's detached callback even when the worker settles first", async () => {
    // Regression: waitFor() snapshotted the detached map *before* the drive it
    // is awaiting registered its detached recovery callback. A worker that
    // settles inside that window fired a spontaneous wake (because it saw no
    // waiter) and self-cleaned, so the caller returned having adopted nothing
    // while a fresh controller generation was already running.
    const { runtime } = fixture();
    let ticks = 0;
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {
        tick: vi.fn(async () => {
          ticks += 1;
          return {
            runtime: { ...runtime.get("mission-1")!, activeTaskId: "task-1" },
            action: "wait:task-1",
            immediate: false,
            waitingForExternal: true,
          };
        }),
      },
      taskRunner: {
        isActive: () => true,
        // Already settled: the detached chain races the drive promise.
        waitFor: () => Promise.resolve(),
      },
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(ticks).toBe(1);
    expect(controllerRunner.isActive("mission-1")).toBe(false);
    expect((controllerRunner as unknown as {
      detachedPromises: Map<string, unknown>;
    }).detachedPromises.size).toBe(0);

    // The caller — not the settled worker — owns advancing the mission.
    controllerRunner.wake("mission-1");
    await controllerRunner.waitFor("mission-1");
    expect(ticks).toBe(2);
  });

  it("keeps a detached callback failure observable to the generation that registered it", async () => {
    const { runtime } = fixture();
    const recovered: string[] = [];
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {
        tick: vi.fn(async () => ({
          runtime: { ...runtime.get("mission-1")!, activeTaskId: "task-1" },
          action: "wait:task-1",
          immediate: false,
          waitingForExternal: true,
        })),
      },
      taskRunner: {
        isActive: () => true,
        waitFor: () => Promise.reject(new Error("worker classification failed")),
      },
      ownerId: "controller-test",
      now: () => now,
    });
    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    recovered.push(...runtime.listRecoveryDecisions("mission-1").map((decision) => decision.diagnosis));
    expect(recovered.some((diagnosis) => diagnosis.includes("worker classification failed"))).toBe(true);
  });

  it("stops at a rejection boundary instead of following a detached revision", async () => {
    const { runtime } = fixture();
    let resolveWorker!: () => void;
    let workerSettled = false;
    const worker = new Promise<void>((resolve) => {
      resolveWorker = () => {
        workerSettled = true;
        resolve();
      };
    });
    let ticks = 0;
    let rejected = false;
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {
        tick: vi.fn(async () => {
          ticks += 1;
          await Promise.resolve();
          if (ticks === 1) {
            rejected = true;
            return {
              runtime: { ...runtime.get("mission-1")!, activeTaskId: "task-1" },
              action: "guardian_rejected",
              immediate: false,
              waitingForExternal: true,
            };
          }
          return {
            runtime: runtime.get("mission-1")!,
            action: "revision_dispatch",
            immediate: false,
            waitingForExternal: false,
          };
        }),
      },
      taskRunner: {
        isActive: () => !workerSettled,
        waitFor: vi.fn(async () => worker),
      },
      ownerId: "controller-test",
      now: () => now,
    });

    const caller = (async () => {
      controllerRunner.run("mission-1");
      while (!rejected) {
        await controllerRunner.waitFor("mission-1");
        if (!rejected && !controllerRunner.isActive("mission-1")) {
          controllerRunner.run("mission-1");
        }
      }
      await controllerRunner.stop("mission-1");
    })();

    await vi.waitFor(() => expect(ticks).toBe(1));
    await vi.waitFor(() => expect((controllerRunner as unknown as {
      detachedPromises: Map<string, unknown>;
    }).detachedPromises.size).toBe(1));
    resolveWorker();
    await caller;

    expect(ticks).toBe(1);
    await vi.waitFor(() => expect((controllerRunner as unknown as {
      detachedPromises: Map<string, unknown>;
    }).detachedPromises.size).toBe(0));

    controllerRunner.wake("mission-1");
    await controllerRunner.waitFor("mission-1");
    expect(ticks).toBe(2);
  });

  it("does not terminal-mutate after repeated drive failures without a lease", async () => {
    const { runtime } = fixture();
    vi.spyOn(runtime, "claimLease").mockImplementation(() => {
      throw new Error("controller drive unavailable");
    });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: { tick: vi.fn() },
      taskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(runtime.get("mission-1")?.state).toBe("executing");
    expect(runtime.listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({
      category: "process_interruption",
      exhausted: true,
      action: "block_precisely",
    }));
  });

  it.each(["waiting_for_approval", "orienting"] as const)("preserves %s when a controller tick fails", async (state) => {
    const { runtime } = fixture(state);
    let attempts = 0;
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: { tick: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error(`${state} tick failed`);
        return { runtime: runtime.get("mission-1")!, action: `wait:${state}`, immediate: false, waitingForExternal: false };
      }) },
      taskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(runtime.get("mission-1")?.state).toBe(state);
    expect(runtime.listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({ exhausted: false }));
  });

  it("propagates runtime read faults instead of reporting a completed driver", async () => {
    const { runtime } = fixture();
    vi.spyOn(runtime, "get").mockImplementation(() => { throw new Error("runtime read unavailable"); });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: { tick: vi.fn() },
      taskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await expect(controllerRunner.waitFor("mission-1")).rejects.toThrow("runtime read unavailable");
  });

  it("propagates runtime recovery-write faults", async () => {
    const { runtime } = fixture();
    vi.spyOn(runtime, "recordRecovery").mockImplementation(() => { throw new Error("recovery write unavailable"); });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: { tick: vi.fn(async () => { throw new Error("tick failed"); }) },
      taskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await expect(controllerRunner.waitFor("mission-1")).rejects.toThrow("recovery write unavailable");
  });

  it("reuses one durable retry after restart without duplicating dispatch", async () => {
    const { db, runtime } = fixture("planning");
    const prepareMission = vi.fn(async () => {
      throw new Error("preparation interrupted");
    });
    const dispatchWorker = vi.fn(() => {
      taskRepository(db).createTask({
        id: "task-1",
        projectId: "project-1",
        missionId: "mission-1",
        kind: "agent_chat",
        status: "queued",
        createdAt: now,
      });
      return { taskId: "task-1" };
    });
    const loadSnapshot = (): ControllerSnapshot => ({
      tasks: runtime.get("mission-1")?.activeTaskId
        ? [{ id: runtime.get("mission-1")!.activeTaskId!, status: "queued" as const }]
        : [],
      approvals: [],
      guardianDecision: guardianPassed,
      recovery: runtime.listRecoveryDecisions("mission-1").at(-1) ?? null,
    });
    const createController = (prepare: () => Promise<{ awaitingApproval: boolean }>) => new MissionController({
      runtime,
      loadSnapshot,
      dispatchWorker,
      finalizeMission: vi.fn(),
      prepareMission: prepare,
      now: () => now,
    });

    let first!: MissionControllerRunner;
    const recordRecovery = runtime.recordRecovery.bind(runtime);
    vi.spyOn(runtime, "recordRecovery").mockImplementation((input) => {
      const decision = recordRecovery(input);
      if (!input.exhausted) first.cancel("mission-1");
      return decision;
    });
    first = new MissionControllerRunner({
      runtime,
      controller: createController(prepareMission),
      taskRunner,
      ownerId: "controller-before-restart",
      now: () => now,
    });
    first.run("mission-1");
    await first.waitFor("mission-1");

    const second = new MissionControllerRunner({
      runtime,
      controller: createController(async () => ({ awaitingApproval: false })),
      taskRunner,
      ownerId: "controller-after-restart",
      now: () => now,
    });
    second.run("mission-1");
    await second.waitFor("mission-1");
    second.wake("mission-1");
    await second.waitFor("mission-1");

    expect(runtime.listRecoveryDecisions("mission-1")).toHaveLength(1);
    expect(dispatchWorker).toHaveBeenCalledTimes(1);
    expect(runtime.listOperations("mission-1").filter((operation) => operation.kind === "dispatch_worker")).toHaveLength(1);
  });

  it("bounds repeated tick failures in an evidenced blocked disposition", async () => {
    const { runtime } = fixture();
    const tick = vi.fn(async () => {
      throw new Error("controller tick failed");
    });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: { tick },
      taskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(tick).toHaveBeenCalledTimes(2);
    expect(runtime.get("mission-1")?.state).toBe("blocked");
    expect(runtime.listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({
      category: "process_interruption",
      exhausted: true,
      action: "block_precisely",
    }));
  });

  it("reconciles a completed dispatch after a tick failure without dispatching twice", async () => {
    const { db, runtime } = fixture();
    const dispatchWorker = vi.fn(() => {
      taskRepository(db).createTask({
        id: "task-1",
        projectId: "project-1",
        missionId: "mission-1",
        kind: "agent_chat",
        status: "queued",
        createdAt: now,
      });
      return { taskId: "task-1" };
    });
    const loadSnapshot = (): ControllerSnapshot => ({
      tasks: runtime.get("mission-1")?.activeTaskId
        ? [{ id: runtime.get("mission-1")!.activeTaskId!, status: "queued" as const }]
        : [],
      approvals: [],
      guardianDecision: guardianPassed,
      recovery: runtime.listRecoveryDecisions("mission-1").at(-1) ?? null,
    });
    const controller = new MissionController({
      runtime,
      loadSnapshot,
      dispatchWorker,
      finalizeMission: vi.fn(),
      now: () => now,
    });
    const originalSetActiveTask = runtime.setActiveTask.bind(runtime);
    let setActiveTaskAttempts = 0;
    vi.spyOn(runtime, "setActiveTask").mockImplementation((input) => {
      setActiveTaskAttempts += 1;
      if (setActiveTaskAttempts === 1) throw new Error("active task persistence failed");
      return originalSetActiveTask(input);
    });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller,
      taskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(dispatchWorker).toHaveBeenCalledTimes(1);
    expect(setActiveTaskAttempts).toBe(2);
    expect(runtime.get("mission-1")?.state).toBe("executing");
    expect(runtime.get("mission-1")?.activeTaskId).toBe("task-1");
    expect(runtime.listOperations("mission-1").filter((operation) => operation.kind === "dispatch_worker")).toHaveLength(1);
  });

  it("reacquires a fence before classifying an isActive failure", async () => {
    const { runtime } = fixture();
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {
        tick: vi.fn(async () => ({
          runtime: { ...runtime.get("mission-1")!, activeTaskId: "task-1" },
          action: "wait:task-1",
          immediate: false,
          waitingForExternal: true,
        })),
      },
      taskRunner: {
        isActive: () => { throw new Error("worker activity probe failed"); },
        waitFor: async () => undefined,
      },
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(runtime.listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({
      category: "process_interruption",
      operationId: expect.any(String),
    }));
  });

  it.each(["completed", "cancelled"] as const)("aligns runtime with authoritative %s after closeout failure", async (status) => {
    const { db, runtime } = fixture("validating");
    const controller = {
      tick: vi.fn(async () => ({
        runtime: runtime.get("mission-1")!,
        action: "terminal:pending:normal_finalize",
        immediate: false,
        waitingForExternal: false,
        terminalOutcome: {
          kind: "normal_finalize" as const,
          reason: "Terminal outcome.",
          preserveStatus: status === "completed" ? "completed" as const : "cancelled" as const,
        },
      })),
    };
    const concludeTerminalOutcome = vi.fn(() => {
      db.prepare("UPDATE missions SET status=? WHERE id=?").run(status, "mission-1");
      throw new Error("closeout failed after aggregate write");
    });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller,
      taskRunner,
      ownerId: "controller-test",
      concludeTerminalOutcome,
      getMissionStatus: (missionId) => (db.prepare("SELECT status FROM missions WHERE id=?").get(missionId) as { status: "completed" | "cancelled" } | undefined)?.status,
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(runtime.get("mission-1")?.state).toBe(status === "completed" ? "completed" : "cancelled");
  });

  it("keeps preparation exceptions as failures instead of entering execution", async () => {
    const { runtime } = fixture("planning");
    const prepareMission = vi.fn(async () => {
      throw new Error("criteria preparation failed");
    });
    const dispatchWorker = vi.fn(() => ({ taskId: "task-1" }));
    const controller = new MissionController({
      runtime,
      loadSnapshot: () => ({
        tasks: [],
        approvals: [],
        guardianDecision: {
          passed: false,
          missing: [],
          failed: [],
          blocked: [],
          nextActions: [],
          evidenceSnapshot: {
            missionId: "mission-1",
            criteria: { total: 0, satisfied: 0 },
            requirements: { authoritative: 0, satisfied: 0 },
            evidence: { passed: 0, failed: 0, inconclusive: 0 },
            operations: { resolved: 0, unresolved: 0 },
            tasks: { resolved: 0, unresolved: 0 },
            approvals: { resolved: 0, unresolved: 0 },
            validation: { required: [], completed: [] },
            changedFiles: [],
          },
        },
        recovery: null,
      }),
      dispatchWorker,
      finalizeMission: vi.fn(),
      prepareMission,
      now: () => now,
    });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller,
      taskRunner,
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(runtime.get("mission-1")?.state).toBe("blocked");
    expect(prepareMission).toHaveBeenCalledTimes(2);
    expect(runtime.listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({
      category: "process_interruption",
      exhausted: true,
    }));
  });

  it("records closeout failure and never reports it as successful completion", async () => {
    const { runtime } = fixture("validating");
    const controller = {
      tick: vi.fn(async () => ({
        runtime: runtime.get("mission-1")!,
        action: "terminal:pending:normal_finalize",
        immediate: false,
        waitingForExternal: false,
        terminalOutcome: {
          kind: "normal_finalize" as const,
          reason: "Guardian passed.",
          preserveStatus: "completed" as const,
        },
      })),
    };
    const concludeTerminalOutcome = vi.fn(() => {
      throw new Error("closeout storage failed");
    });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller,
      taskRunner,
      ownerId: "controller-test",
      concludeTerminalOutcome,
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(concludeTerminalOutcome).toHaveBeenCalledTimes(2);
    expect(runtime.get("mission-1")?.state).toBe("blocked");
    expect(runtime.listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({
      category: "unknown_effect",
      exhausted: true,
      action: "block_precisely",
    }));
  });

  it("durably records a startup closeout rejection before allowing a later retry", async () => {
    const { db, runtime } = fixture("validating");
    db.prepare("UPDATE missions SET status=? WHERE id=?").run("blocked", "mission-1");
    let shouldFail = true;
    const concludeTerminalOutcome = vi.fn(() => {
      if (shouldFail) throw new Error("startup closeout storage failed");
      return undefined;
    });
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {} as never,
      taskRunner,
      ownerId: "controller-startup-closeout",
      concludeTerminalOutcome,
      now: () => now,
    });

    await expect(controllerRunner.reconcileTerminalOutcome("mission-1", {
      kind: "startup_reconciliation",
      reason: "Resume the terminal close-out.",
      preserveStatus: "blocked",
    })).rejects.toThrow("startup closeout storage failed");
    expect(runtime.get("mission-1")?.state).toBe("validating");
    expect(runtime.listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({
      category: "unknown_effect",
      exhausted: false,
    }));

    shouldFail = false;
    await controllerRunner.reconcileTerminalOutcome("mission-1", {
      kind: "startup_reconciliation",
      reason: "Resume the terminal close-out.",
      preserveStatus: "blocked",
    });
    expect(runtime.get("mission-1")?.state).toBe("blocked");
  });

  it("does not swallow a closeout rejection when runtime is already terminal", async () => {
    const { runtime } = fixture("blocked");
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: {} as never,
      taskRunner,
      ownerId: "controller-terminal-closeout",
      concludeTerminalOutcome: () => {
        throw new Error("terminal closeout unavailable");
      },
      now: () => now,
    });

    await expect(controllerRunner.reconcileTerminalOutcome("mission-1", {
      kind: "startup_reconciliation",
      reason: "Check the terminal record.",
      preserveStatus: "blocked",
    })).rejects.toThrow("terminal closeout unavailable");
  });
});
