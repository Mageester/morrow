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
    expect(repo.listEvents(mission.id).some((e) => e.type === "mission.conclusion_started")).toBe(true);
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
});
