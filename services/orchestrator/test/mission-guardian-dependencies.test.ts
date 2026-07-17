import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { MissionService } from "../src/mission/service.js";

/**
 * A worker the controller has already recovered from is a historical fact, not
 * live work. It stays `interrupted` forever by design (production dispatches a
 * replacement rather than mutating the old row), so if the Guardian counted it
 * as a dependency, any mission that survived a single worker interruption could
 * never be authorized.
 */
describe("guardian dependencies exclude superseded workers", () => {
  const at = "2026-01-01T00:00:00.000Z";

  function setup() {
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: "/tmp/ws", createdAt: at });
    const missions = missionsRepository(db);
    const service = new MissionService({
      repo: missions,
      getWorkspacePath: () => "/tmp/ws",
      backupDir: "/tmp/ws/checkpoints",
    });
    const mission = service.create("p", { objective: "Objective", autoApprove: true });
    missionRuntimeRepository(db).create({ missionId: mission.id, now: at });
    return { db, missions, missionId: mission.id };
  }

  function addTask(db: ReturnType<typeof openDatabase>, missionId: string, id: string, status: string) {
    taskRepository(db).createTask({
      id, projectId: "p", kind: "agent_chat", status: "queued", missionId, createdAt: at,
    });
    db.prepare("UPDATE tasks SET status=? WHERE id=?").run(status, id);
  }

  it("still reports an interrupted worker the controller has not recovered from", () => {
    const { db, missions, missionId } = setup();
    addTask(db, missionId, "worker-1", "interrupted");

    const blocking = missions.guardianDependencies(missionId).tasks;

    expect(blocking.map((task) => task.id)).toEqual(["worker-1"]);
    db.close();
  });

  it("drops a worker the controller recorded a recovery transition for", () => {
    const { db, missions, missionId } = setup();
    const runtime = missionRuntimeRepository(db);
    addTask(db, missionId, "worker-1", "interrupted");
    addTask(db, missionId, "worker-2", "completed");

    // The exact durable trail production writes when it supersedes a worker.
    runtime.transition({ missionId, from: "created", to: "orienting", cause: "controller_started", actor: "controller", now: at });
    runtime.transition({ missionId, from: "orienting", to: "planning", cause: "orientation_complete", actor: "controller", now: at });
    runtime.transition({ missionId, from: "planning", to: "executing", cause: "plan_ready", actor: "controller", now: at });
    runtime.transition({
      missionId, from: "executing", to: "recovering",
      cause: "worker_recovery_required", actor: "controller",
      details: { taskId: "worker-1" }, now: at,
    });

    const blocking = missions.guardianDependencies(missionId).tasks;

    // worker-1 is superseded; worker-2 is the live lineage and remains visible.
    expect(blocking.map((task) => task.id)).toEqual(["worker-2"]);
    db.close();
  });
});

/**
 * `guardian_review` is the Guardian's own completion bookkeeping, not mission
 * work. The controller marks it `running` and then calls finalize, which
 * re-assesses the Guardian — so if it counted as a dependency, finalizing would
 * make finalization impossible, and the resulting failed operation would poison
 * every later evaluation.
 */
describe("guardian dependencies exclude the guardian's own completion operation", () => {
  const at = "2026-01-01T00:00:00.000Z";

  function setup() {
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: "/tmp/ws", createdAt: at });
    const missions = missionsRepository(db);
    const service = new MissionService({
      repo: missions,
      getWorkspacePath: () => "/tmp/ws",
      backupDir: "/tmp/ws/checkpoints",
    });
    const mission = service.create("p", { objective: "Objective", autoApprove: true });
    const runtime = missionRuntimeRepository(db);
    runtime.create({ missionId: mission.id, now: at });
    const fence = runtime.claimLease({
      missionId: mission.id, ownerId: "test-owner", now: at,
      expiresAt: new Date(Date.parse(at) + 60_000).toISOString(),
    })!;
    return { db, missions, runtime, missionId: mission.id, fence };
  }

  it("ignores an in-flight guardian_review operation", () => {
    const { db, missions, runtime, missionId, fence } = setup();
    const operation = runtime.enqueueOperation({
      missionId, idempotencyKey: `guardian:${missionId}:complete`, kind: "guardian_review",
      strategyFingerprint: "guardian:completion", input: {}, fence, now: at,
    });
    runtime.startOperation({ missionId, operationId: operation.id, fence, now: at });

    expect(missions.guardianDependencies(missionId).operations).toEqual([]);
    db.close();
  });

  it("ignores a failed guardian_review so a retry is not permanently poisoned", () => {
    const { db, missions, runtime, missionId, fence } = setup();
    const operation = runtime.enqueueOperation({
      missionId, idempotencyKey: `guardian:${missionId}:complete`, kind: "guardian_review",
      strategyFingerprint: "guardian:completion", input: {}, fence, now: at,
    });
    runtime.startOperation({ missionId, operationId: operation.id, fence, now: at });
    runtime.failOperation({ missionId, operationId: operation.id, fence, result: { message: "boom" }, now: at });

    expect(missions.guardianDependencies(missionId).operations).toEqual([]);
    db.close();
  });

  it("still reports real mission work operations", () => {
    const { db, missions, runtime, missionId, fence } = setup();
    const operation = runtime.enqueueOperation({
      missionId, idempotencyKey: `dispatch:${missionId}:phase:1`, kind: "dispatch_worker",
      strategyFingerprint: "worker:primary", input: {}, fence, now: at,
    });
    runtime.startOperation({ missionId, operationId: operation.id, fence, now: at });
    runtime.failOperation({ missionId, operationId: operation.id, fence, result: { message: "boom" }, now: at });

    expect(missions.guardianDependencies(missionId).operations.map((o) => o.status)).toEqual(["failed"]);
    db.close();
  });
});
