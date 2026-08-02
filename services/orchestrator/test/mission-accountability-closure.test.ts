import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { MissionRuntimeState } from "@morrow/contracts";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { MissionController, type ControllerSnapshot } from "../src/mission/controller.js";
import type { GuardianDecision } from "../src/mission/guardian.js";
import { MissionService } from "../src/mission/service.js";

/**
 * The evidence gap this file pins.
 *
 * A packaged run against a real external model built a complete, working,
 * tested app — and the mission recorded ZERO evidence and never left status
 * `running`. Every evidence gate hung off the Guardian-pass path, which needs a
 * worker task to reach `completed`. When automatic recovery ran out of
 * strategies instead, the runtime parked in `blocked` and nothing else
 * happened: no gates, no evidence, no grade, forever `running`.
 *
 * Producing the artifact and closing the accountability loop are separate
 * problems. These tests are about the second one.
 */

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

const now = "2026-07-30T12:00:00.000Z";

const failedGuardian: GuardianDecision = {
  passed: false,
  missing: [{ kind: "criterion", id: "criterion-1", criterionId: "criterion-1", detail: "Missing evidence." }],
  failed: [],
  blocked: [],
  nextActions: ["validate_criteria"],
  evidenceSnapshot: {
    missionId: "mission-1",
    criteria: { total: 1, satisfied: 0 },
    requirements: { authoritative: 0, satisfied: 0 },
    evidence: { passed: 0, failed: 0, inconclusive: 0 },
    operations: { resolved: 0, unresolved: 0 },
    tasks: { resolved: 0, unresolved: 1 },
    approvals: { resolved: 0, unresolved: 0 },
    validation: { required: [], completed: [] },
    changedFiles: [],
  },
};

function controllerHarness(state: MissionRuntimeState, snapshot: Partial<ControllerSnapshot> = {}) {
  const db = openDatabase(":memory:");
  projectRepository(db).createProject({ id: "project-1", name: "Project", workspacePath: "/workspace", createdAt: now });
  db.prepare(`INSERT INTO missions
    (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run("mission-1", 1, "project-1", "Durable work", "running", 1, "{}", now, now);
  const runtime = missionRuntimeRepository(db);
  runtime.create({ missionId: "mission-1", state, now });
  const fence = runtime.claimLease({ missionId: "mission-1", ownerId: "controller-1", now, expiresAt: "2026-07-30T12:01:00.000Z" })!;
  const current: ControllerSnapshot = { tasks: [], approvals: [], guardianDecision: failedGuardian, recovery: null, ...snapshot };
  const concludeMission = vi.fn(async (_missionId: string, _reason: string) => undefined);
  const controller = new MissionController({
    runtime,
    loadSnapshot: () => current,
    dispatchWorker: () => ({ taskId: "task-1" }),
    finalizeMission: vi.fn(),
    concludeMission,
    validateMission: vi.fn(),
    reviewMission: vi.fn(),
    now: () => now,
  });
  return { db, runtime, fence, controller, concludeMission };
}

const exhausted = {
  category: "process_interruption" as const,
  diagnosis: "No materially different automatic strategy remains.",
  failedStrategyFingerprint: "strategy:process_interruption:restore_checkpoint",
  nextStrategyFingerprint: null,
  action: "block_precisely" as const,
  retryCondition: null,
  exhausted: true,
};

describe("controller closes the accountability loop before parking", () => {
  it("concludes the mission when no automatic strategy remains", async () => {
    const { db, controller, fence, concludeMission } = controllerHarness("recovering", { recovery: exhausted });
    const result = await controller.tick("mission-1", fence);
    expect(result.runtime.state).toBe("blocked");
    expect(concludeMission).toHaveBeenCalledTimes(1);
    expect(concludeMission.mock.calls[0]![0]).toBe("mission-1");
    // The reason is the recovery diagnosis, so the give-up is explained.
    expect(String(concludeMission.mock.calls[0]![1])).toContain("No materially different automatic strategy");
    db.close();
  });

  it("still reaches the terminal runtime state when closing out throws", async () => {
    const { db, runtime, fence, concludeMission } = controllerHarness("recovering", { recovery: exhausted });
    concludeMission.mockRejectedValue(new Error("grading exploded"));
    const controller = new MissionController({
      runtime,
      loadSnapshot: () => ({ tasks: [], approvals: [], guardianDecision: failedGuardian, recovery: exhausted }),
      dispatchWorker: () => ({ taskId: "task-1" }),
      finalizeMission: vi.fn(),
      concludeMission,
      now: () => now,
    });
    // A mission that cannot terminate at all is worse than one that terminates
    // ungraded, so a close-out failure must not trap it in `recovering`.
    expect((await controller.tick("mission-1", fence)).runtime.state).toBe("blocked");
    db.close();
  });

  it("does not conclude while recovery still has a strategy left", async () => {
    const { db, controller, fence, concludeMission } = controllerHarness("recovering", {
      recovery: { ...exhausted, exhausted: false, action: "replan", nextStrategyFingerprint: "worker:alternate-strategy" },
    });
    expect((await controller.tick("mission-1", fence)).runtime.state).toBe("replanning");
    expect(concludeMission).not.toHaveBeenCalled();
    db.close();
  });
});

function serviceHarness() {
  const workspace = tmp("closure-ws-");
  spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "t@t.co"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "t"], { cwd: workspace });
  const db = openDatabase(":memory:");
  projectRepository(db).createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: new Date().toISOString() });
  const repo = missionsRepository(db);
  const service = new MissionService({
    repo,
    getWorkspacePath: (pid) => (pid === "p1" ? workspace : undefined),
    backupDir: join(tmp("closure-home-"), "mission-checkpoints"),
    runOptions: {
      // Deterministic gate: no real process, no real network.
      exec: async (command) => command.includes("pass")
        ? { exitCode: 0, output: "ok", timedOut: false }
        : { exitCode: 1, output: "boom", timedOut: false },
    },
  });
  return { db, service, repo, workspace };
}

describe("MissionService.concludeWithoutSuccess", () => {
  it("runs the gates, records evidence, and grades a mission that never passed the Guardian", async () => {
    const { db, service, repo } = serviceHarness();
    const mission = service.create("p1", { objective: "Build it" });
    service.addCriterion(mission.id, "The suite passes", { kind: "test", command: "npm test -- pass", expectExitCode: 0 });
    service.addCriterion(mission.id, "The build works", { kind: "build", command: "npm run build", expectExitCode: 0 });
    service.approveCriteria(mission.id);
    expect(repo.get(mission.id)!.status).toBe("running");
    expect(repo.listEvidence(mission.id)).toHaveLength(0);

    const concluded = await service.concludeWithoutSuccess(mission.id, "strategies exhausted");

    // The whole point: a terminal status, a populated ledger, an honest grade.
    expect(concluded.status).not.toBe("running");
    expect(["partially_completed", "blocked", "failed"]).toContain(concluded.status);
    const evidence = repo.listEvidence(mission.id);
    expect(evidence.length).toBeGreaterThanOrEqual(2);
    expect(evidence.some((e) => e.status === "passed")).toBe(true);
    expect(evidence.some((e) => e.status === "failed")).toBe(true);
    expect(concluded.result).not.toBeNull();
    expect(concluded.result?.status).toBe(concluded.status);
    expect(repo.listEvents(mission.id).filter((e) => e.type === "mission.conclusion_started")).toHaveLength(1);
    expect(repo.listEvents(mission.id).filter((e) => e.type === "mission.terminal_outcome_recorded")).toHaveLength(1);
    db.close();
  });

  it("never grades a criterion satisfied without passing evidence", async () => {
    const { db, service, repo } = serviceHarness();
    const mission = service.create("p1", { objective: "Build it" });
    service.addCriterion(mission.id, "The build works", { kind: "build", command: "npm run build", expectExitCode: 0 });
    service.approveCriteria(mission.id);

    const concluded = await service.concludeWithoutSuccess(mission.id, "strategies exhausted");

    expect(concluded.status).not.toBe("completed");
    expect(concluded.status).not.toBe("completed_with_reservations");
    const criterion = repo.get(mission.id)!.criteria[0]!;
    expect(criterion.state).not.toBe("verified");
    db.close();
  });

  it("is a no-op on an already terminal mission", async () => {
    const { db, service, repo } = serviceHarness();
    const mission = service.create("p1", { objective: "Build it" });
    service.addCriterion(mission.id, "The suite passes", { kind: "test", command: "npm test -- pass", expectExitCode: 0 });
    service.approveCriteria(mission.id);
    await service.concludeWithoutSuccess(mission.id, "first");
    const terminal = repo.get(mission.id)!;
    const evidenceCount = repo.listEvidence(mission.id).length;

    const again = await service.concludeWithoutSuccess(mission.id, "second");

    expect(again.status).toBe(terminal.status);
    expect(repo.listEvidence(mission.id)).toHaveLength(evidenceCount);
    expect(repo.listEvents(mission.id).filter((e) => e.type === "mission.conclusion_started")).toHaveLength(1);
    expect(repo.listEvents(mission.id).filter((e) => e.type === "mission.terminal_outcome_recorded")).toHaveLength(1);
    db.close();
  });

  it("rejects a terminal outcome whose durable result is later contradicted", async () => {
    const { db, service, repo } = serviceHarness();
    const mission = service.create("p1", { objective: "Build it" });
    service.addCriterion(mission.id, "The suite passes", { kind: "test", command: "npm test -- pass", expectExitCode: 0 });
    service.approveCriteria(mission.id);
    const concluded = await service.concludeWithoutSuccess(mission.id, "strategies exhausted");
    repo.setResult(mission.id, { ...concluded.result!, status: concluded.status === "blocked" ? "failed" : "blocked" });

    await expect(service.concludeTerminalOutcome(mission.id, {
      kind: "startup_reconciliation",
      reason: "reconcile",
      preserveStatus: concluded.status,
    })).rejects.toMatchObject({ code: "finalization_integrity_error" });
    db.close();
  });

  it("closes out even when a gate throws", async () => {
    const workspace = tmp("closure-throw-ws-");
    writeFileSync(join(workspace, "marker.txt"), "x");
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: new Date().toISOString() });
    const repo = missionsRepository(db);
    const service = new MissionService({
      repo,
      getWorkspacePath: () => workspace,
      backupDir: join(tmp("closure-throw-home-"), "mission-checkpoints"),
      runOptions: { exec: async () => { throw new Error("exec blew up"); } },
    });
    const mission = service.create("p1", { objective: "Build it" });
    service.addCriterion(mission.id, "The suite passes", { kind: "test", command: "npm test", expectExitCode: 0 });
    service.approveCriteria(mission.id);

    const concluded = await service.concludeWithoutSuccess(mission.id, "strategies exhausted");

    expect(concluded.status).not.toBe("running");
    expect(repo.listEvents(mission.id).some((e) => e.type === "mission.conclusion_gate_failed")).toBe(true);
    db.close();
  });

  it("uses one durable close-out claimant across MissionService instances", async () => {
    const workspace = tmp("closure-claim-ws-");
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: now });
    const repo = missionsRepository(db);
    const repoA = missionsRepository(db);
    const repoB = missionsRepository(db);
    const mission = new MissionService({
      repo,
      getWorkspacePath: () => workspace,
      backupDir: join(tmp("closure-claim-home-a-"), "mission-checkpoints"),
      serviceInstanceId: "closeout-owner-a",
    }).create("p1", { objective: "Build it" });
    const execCalls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const exec = async () => {
      execCalls.push("verify");
      if (execCalls.length === 1) firstStarted();
      await gate;
      return { exitCode: 0, output: "ok", timedOut: false };
    };
    const serviceA = new MissionService({
      repo: repoA,
      getWorkspacePath: () => workspace,
      backupDir: join(tmp("closure-claim-home-a-2-"), "mission-checkpoints"),
      serviceInstanceId: "closeout-owner-a",
      runOptions: { exec },
    });
    serviceA.addCriterion(mission.id, "The suite passes", { kind: "test", command: "npm test", expectExitCode: 0 });
    serviceA.approveCriteria(mission.id);
    repoA.setStatus(mission.id, "blocked", now);
    const serviceB = new MissionService({
      repo: repoB,
      getWorkspacePath: () => workspace,
      backupDir: join(tmp("closure-claim-home-b-"), "mission-checkpoints"),
      serviceInstanceId: "closeout-owner-b",
      runOptions: { exec },
    });

    const first = serviceA.concludeTerminalOutcome(mission.id, {
      kind: "controller_exhausted",
      reason: "Recovery strategies exhausted.",
      preserveStatus: "blocked",
    });
    await firstStarted;
    const second = serviceB.concludeTerminalOutcome(mission.id, {
      kind: "controller_exhausted",
      reason: "Recovery strategies exhausted.",
      preserveStatus: "blocked",
    });
    const secondResult = second.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(execCalls).toHaveLength(1);
    release();

    await first;
    expect((await secondResult).error).toMatchObject({ code: "terminal_closeout_in_progress" });
    expect(repo.listEvents(mission.id).filter((event) => event.type === "mission.terminal_outcome_recorded")).toHaveLength(1);
    db.close();
  });

  it("recovers a stale close-out claimant without duplicating verification", async () => {
    const workspace = tmp("closure-stale-claim-ws-");
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: now });
    const repo = missionsRepository(db);
    const service = new MissionService({
      repo,
      getWorkspacePath: () => workspace,
      backupDir: join(tmp("closure-stale-claim-home-"), "mission-checkpoints"),
      serviceInstanceId: "closeout-owner-live",
      now: () => now,
      runOptions: { exec: async () => ({ exitCode: 0, output: "ok", timedOut: false }) },
    });
    const mission = service.create("p1", { objective: "Recover the close-out" });
    service.addCriterion(mission.id, "The suite passes", { kind: "test", command: "npm test", expectExitCode: 0 });
    service.approveCriteria(mission.id);
    repo.setStatus(mission.id, "blocked", now);
    repo.claimTerminalOutcome({
      missionId: mission.id,
      kind: "controller_exhausted",
      reason: "The previous process stopped.",
      preserveStatus: "blocked",
      ownerId: "dead-closeout-owner",
      now: "2026-07-30T11:00:00.000Z",
      leaseExpiresAt: "2026-07-30T11:01:00.000Z",
    });

    const concluded = await service.concludeTerminalOutcome(mission.id, {
      kind: "startup_reconciliation",
      reason: "Resume stale close-out.",
      preserveStatus: "blocked",
    });

    expect(concluded.status).toBe("blocked");
    expect(repo.listEvidence(mission.id)).toHaveLength(1);
    expect(repo.listEvents(mission.id).filter((event) => event.type === "mission.terminal_outcome_recorded")).toHaveLength(1);
    expect(db.prepare("SELECT owner_id AS ownerId, status FROM mission_terminal_outcome_claims WHERE mission_id=?").get(mission.id))
      .toEqual({ ownerId: "closeout-owner-live", status: "completed" });
    db.close();
  });

  it("does not duplicate verification after a heartbeat loss during close-out", async () => {
    const workspace = tmp("closure-heartbeat-loss-ws-");
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "proj", workspacePath: workspace, createdAt: now });
    const repo = missionsRepository(db);
    const repoA = missionsRepository(db);
    const repoB = missionsRepository(db);
    const seed = new MissionService({
      repo,
      getWorkspacePath: () => workspace,
      backupDir: join(tmp("closure-heartbeat-loss-seed-"), "mission-checkpoints"),
      now: () => now,
    });
    const mission = seed.create("p1", { objective: "Keep one close-out verification" });
    const execCalls: string[] = [];
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    let verificationStarted!: () => void;
    const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
    const exec = async () => {
      execCalls.push("verify");
      if (execCalls.length === 1) verificationStarted();
      await verificationGate;
      return { exitCode: 0, output: "ok", timedOut: false };
    };
    const serviceA = new MissionService({
      repo: repoA,
      getWorkspacePath: () => workspace,
      backupDir: join(tmp("closure-heartbeat-loss-a-"), "mission-checkpoints"),
      serviceInstanceId: "closeout-heartbeat-owner-a",
      now: () => now,
      terminalOutcomeLeaseMs: 30,
      runOptions: { exec },
    });
    serviceA.addCriterion(mission.id, "The suite passes", { kind: "test", command: "npm test", expectExitCode: 0 });
    serviceA.approveCriteria(mission.id);
    repoA.setStatus(mission.id, "blocked", now);
    const serviceB = new MissionService({
      repo: repoB,
      getWorkspacePath: () => workspace,
      backupDir: join(tmp("closure-heartbeat-loss-b-"), "mission-checkpoints"),
      serviceInstanceId: "closeout-heartbeat-owner-b",
      now: () => "2026-07-30T12:00:01.000Z",
      terminalOutcomeLeaseMs: 30,
      runOptions: { exec },
    });
    const heartbeatLost = new Promise<void>((resolve) => {
      vi.spyOn(repoA, "renewTerminalOutcomeClaim").mockImplementation(({ ownerId }) => {
        if (ownerId === "closeout-heartbeat-owner-a") resolve();
        return false;
      });
    });

    const observe = <T>(promise: Promise<T>) => promise.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    const first = observe(serviceA.concludeTerminalOutcome(mission.id, {
      kind: "controller_exhausted",
      reason: "The first close-out lost its heartbeat.",
      preserveStatus: "blocked",
    }));
    await verificationStarted;
    await heartbeatLost;
    const second = observe(serviceB.concludeTerminalOutcome(mission.id, {
      kind: "startup_reconciliation",
      reason: "Recover the expired close-out claim.",
      preserveStatus: "blocked",
    }));
    const secondResult = await second;
    expect(secondResult.error).toMatchObject({ code: "terminal_closeout_in_progress" });
    expect(repoA.getTerminalOutcomeClaim(mission.id)?.verificationStatus).toBe("abandoned");
    const third = observe(serviceB.concludeTerminalOutcome(mission.id, {
      kind: "startup_reconciliation",
      reason: "Retry while the original verifier is still blocked.",
      preserveStatus: "blocked",
    }));

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(execCalls).toHaveLength(1);
    } finally {
      releaseVerification();
      await Promise.all([first, third]);
    }
    const firstResult = await first;
    expect(firstResult.error).toMatchObject({ code: "terminal_closeout_in_progress" });
    const thirdResult = await third;
    expect(thirdResult.error).toMatchObject({ code: "terminal_closeout_in_progress" });

    const recovered = await serviceB.concludeTerminalOutcome(mission.id, {
      kind: "startup_reconciliation",
      reason: "Resume after the lost owner stopped.",
      preserveStatus: "blocked",
    });
    expect(recovered.status).toBe("blocked");
    expect(execCalls).toHaveLength(1);
    expect(repoA.listEvidence(mission.id)).toHaveLength(1);
    expect(repoA.listEvents(mission.id).filter((event) => event.type === "mission.terminal_outcome_recorded")).toHaveLength(1);
    db.close();
  });
});
