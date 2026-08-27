import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { teamsRepository } from "../src/repositories/teams.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { teammateProfileFingerprint } from "../src/tools/teammate-delegation.js";
import { taskStartClaimsRepository } from "../src/repositories/task-start-claims.js";
import {
  createWorkGraphTaskAdapter,
  type WorkGraphTaskAdapter,
} from "../src/mission/work-graph-task-adapter.js";
import type { SpawnChildRequest } from "../src/mission/work-graph-orchestrator.js";

const NOW = "2026-08-27T12:00:00.000Z";

function policyFingerprint(ownerId: string, ownerProfileHash: string): string {
  return `policy:${createHash("sha256")
    .update(JSON.stringify({ ownerId, ownerProfileHash }), "utf8")
    .digest("hex")}`;
}

describe("WorkGraphTaskAdapter", () => {
  let db: Database.Database;
  let adapter: WorkGraphTaskAdapter;
  let run: ReturnType<typeof vi.fn<(taskId: string) => void>>;
  let targetId: string;
  let profileHash: string;
  let previousMockProvider: string | undefined;

  beforeEach(() => {
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    projectRepository(db).createProject({
      id: "project",
      name: "Project",
      workspacePath: "/tmp/project",
      createdAt: NOW,
    });
    taskRepository(db).createTask({
      id: "parent",
      projectId: "project",
      kind: "agent_chat",
      status: "running",
      createdAt: NOW,
    });
    const target = agentsRepository(db).create({
      id: "worker",
      projectId: "project",
      name: "Worker",
      role: "researcher",
      providerOverride: "mock",
      modelOverride: "worker-model",
    });
    targetId = target.id;
    profileHash = teammateProfileFingerprint(target, agentsRepository(db).listToolPermissions(target.id));
    run = vi.fn<(taskId: string) => void>();
    adapter = createWorkGraphTaskAdapter({ db, runner: { run } });
  });

  afterEach(() => {
    db.close();
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
  });

  function request(overrides: Partial<SpawnChildRequest> = {}): SpawnChildRequest {
    const admissionId = "admission:graph-1:unit:worker";
    return {
      graphId: "graph-1",
      parentTaskId: "parent",
      unitId: "unit:worker",
      idempotencyKey: admissionId,
      admissionId,
      ownerId: targetId,
      ownerProfileHash: profileHash,
      policyFingerprint: policyFingerprint(targetId, profileHash),
      objective: "Inspect the project",
      role: "work",
      dependencyIds: [],
      ...overrides,
    };
  }

  it("dispatches a deferred child with the admission idempotency key, target binding, and one authoritative start", async () => {
    const first = await adapter.dispatchChild(request());

    expect(first).toMatchObject({ childTaskId: expect.any(String), replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(first.childTaskId);
    expect(db.prepare("SELECT idempotency_key,expected_agent_profile_hash,parent_task_id,agent_id,status FROM tasks WHERE id=?")
      .get(first.childTaskId)).toMatchObject({
      idempotency_key: "admission:graph-1:unit:worker",
      expected_agent_profile_hash: profileHash,
      parent_task_id: "parent",
      agent_id: targetId,
      status: "queued",
    });
  });

  it("replays the exact durable child without exposing routing/provider fields or starting twice", async () => {
    const first = await adapter.dispatchChild(request());
    const replay = await adapter.dispatchChild(request());

    expect(replay).toEqual({ childTaskId: first.childTaskId, replayed: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain("providerId");
    expect(JSON.stringify(first)).not.toContain("worker-model");
    expect(taskRepository(db).listChildren("parent")).toHaveLength(1);
    expect(adapter.findChildByAdmissionId("admission:missing")).toBeNull();
  });

  it("allows only one runner to start a queued child when two adapters replay after a restart", async () => {
    const seedAdapter = createWorkGraphTaskAdapter({
      db,
      runner: { run: vi.fn() },
      startClaimOwnerId: "morrow-pid:999999999:dead",
    });
    const first = await seedAdapter.dispatchChild(request());
    const runA = vi.fn<(taskId: string) => void>();
    const runB = vi.fn<(taskId: string) => void>();
    const adapterA = createWorkGraphTaskAdapter({ db, runner: { run: runA } });
    const adapterB = createWorkGraphTaskAdapter({ db, runner: { run: runB } });

    const [replayA, replayB] = await Promise.all([
      adapterA.dispatchChild(request()),
      adapterB.dispatchChild(request()),
    ]);

    expect(replayA).toEqual({ childTaskId: first.childTaskId, replayed: true });
    expect(replayB).toEqual({ childTaskId: first.childTaskId, replayed: true });
    expect(runA.mock.calls.length + runB.mock.calls.length).toBe(1);
  });

  it("starts a queued child exactly once when two orchestrator processes replay it over separate connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-work-graph-start-"));
    const path = join(directory, "morrow.db");
    const dbA = openDatabase(path);
    const dbB = openDatabase(path);
    try {
      projectRepository(dbA).createProject({ id: "project", name: "Project", workspacePath: "/tmp/project", createdAt: NOW });
      taskRepository(dbA).createTask({ id: "parent", projectId: "project", kind: "agent_chat", status: "running", createdAt: NOW });
      const target = agentsRepository(dbA).create({
        id: "worker",
        projectId: "project",
        name: "Worker",
        role: "researcher",
        providerOverride: "mock",
        modelOverride: "worker-model",
      });
      const hash = teammateProfileFingerprint(target, agentsRepository(dbA).listToolPermissions(target.id));
      const spawn = (overrides: Partial<SpawnChildRequest> = {}): SpawnChildRequest => ({
        graphId: "graph-1",
        parentTaskId: "parent",
        unitId: "unit:worker",
        idempotencyKey: "admission:graph-1:unit:worker",
        admissionId: "admission:graph-1:unit:worker",
        ownerId: target.id,
        ownerProfileHash: hash,
        policyFingerprint: policyFingerprint(target.id, hash),
        objective: "Inspect the project",
        role: "work",
        dependencyIds: [],
        ...overrides,
      });

      // Hold process A inside its start so process B attempts its own start
      // while A owns the fence but has not yet driven the child out of
      // "queued" — precisely the window the durable claim has to cover.
      let releaseA!: () => void;
      const startedA = new Promise<void>((resolve) => { releaseA = resolve; });
      const runA = vi.fn<(taskId: string) => Promise<void>>(() => startedA);
      const runB = vi.fn<(taskId: string) => void>();
      const adapterA = createWorkGraphTaskAdapter({ db: dbA, runner: { run: runA }, startClaimOwnerId: "owner-a" });
      const adapterB = createWorkGraphTaskAdapter({ db: dbB, runner: { run: runB }, startClaimOwnerId: "owner-b" });

      const pendingA = adapterA.dispatchChild(spawn());
      const resultB = await adapterB.dispatchChild(spawn());

      expect(runA).toHaveBeenCalledTimes(1);
      expect(runB).not.toHaveBeenCalled();
      // The winner's fence is durable and visible from the other connection.
      expect(taskStartClaimsRepository(dbB).get(resultB.childTaskId)?.ownerId).toBe("owner-a");

      releaseA();
      const resultA = await pendingA;
      expect(resultA.childTaskId).toBe(resultB.childTaskId);
      expect(runA.mock.calls.length + runB.mock.calls.length).toBe(1);
      expect(taskRepository(dbA).listChildren("parent")).toHaveLength(1);
    } finally {
      dbA.close();
      dbB.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("terminalizes the durable start fence when the child settles", async () => {
    const listeners = new Set<(taskId: string) => void>();
    const settlingRunner = {
      run: vi.fn<(taskId: string) => void>(),
      onSettled: (listener: (taskId: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const settlingAdapter = createWorkGraphTaskAdapter({ db, runner: settlingRunner, startClaimOwnerId: "owner-settling" });
    const dispatched = await settlingAdapter.dispatchChild(request());
    expect(taskStartClaimsRepository(db).get(dispatched.childTaskId)?.ownerId).toBe("owner-settling");

    db.prepare("UPDATE tasks SET status='completed',updated_at=?,completed_at=? WHERE id=?")
      .run(NOW, NOW, dispatched.childTaskId);
    for (const listener of listeners) listener(dispatched.childTaskId);

    expect(taskStartClaimsRepository(db).get(dispatched.childTaskId)).toBeNull();
    // A settled terminal child is not startable again by any owner.
    expect(taskStartClaimsRepository(db).claim({
      taskId: dispatched.childTaskId,
      ownerId: "owner-other",
      now: NOW,
      leaseMs: 60_000,
    })).toMatchObject({ acquired: false, reason: "not_startable" });
    settlingAdapter.close();
  });

  it("passes explicit recovery context when an interrupted child is replayed", async () => {
    const seedAdapter = createWorkGraphTaskAdapter({
      db,
      runner: { run: vi.fn() },
      startClaimOwnerId: "morrow-pid:999999999:dead",
    });
    const first = await seedAdapter.dispatchChild(request());
    db.prepare("UPDATE tasks SET status='interrupted',updated_at=? WHERE id=?").run(NOW, first.childTaskId);
    const recoveredRun = vi.fn<(taskId: string, options?: { recovered?: boolean }) => void>();
    const recoveredAdapter = createWorkGraphTaskAdapter({ db, runner: { run: recoveredRun } });

    await recoveredAdapter.dispatchChild(request());

    expect(recoveredRun).toHaveBeenCalledWith(first.childTaskId, { recovered: true });
  });

  it("uses the authoritative SQLite child reader and returns durable evidence only", async () => {
    const result = await adapter.dispatchChild(request());
    const childId = result.childTaskId;
    const records = taskRecordsRepository(db);
    records.transitionTask(childId, "running", { id: "child-running", createdAt: NOW, payload: {} });
    records.appendEvidence({
      id: "evidence-1",
      taskId: childId,
      type: "file",
      path: "result.md",
      metadata: { contentHash: "abc" },
      createdAt: NOW,
    });
    records.upsertVerification({ taskId: childId, status: "verified", summary: "passed", details: {}, createdAt: NOW, updatedAt: NOW });
    db.prepare("UPDATE tasks SET status='completed',updated_at=?,completed_at=? WHERE id=?").run(NOW, NOW, childId);
    db.prepare("INSERT INTO canonical_task_answers(id,task_id,mission_id,content,evidence_json,created_at) VALUES(?,?,?,?,?,?)")
      .run("answer-1", childId, null, "Durable answer", JSON.stringify({ sourceTurnKey: "turn-1", durableEventCursor: 2 }), NOW);

    expect(adapter.readChild(childId)).toMatchObject({
      id: childId,
      parentTaskId: "parent",
      status: "completed",
      agentId: targetId,
      ownerProfileHash: profileHash,
      policyFingerprint: policyFingerprint(targetId, profileHash),
      canonicalAnswer: { content: "Durable answer", taskId: childId },
      evidence: [{ id: "evidence-1", independentlyObserved: true, durable: true }],
      artifacts: [{ contentHash: "sha256:abc", independentlyObserved: true, durable: true }],
      verification: { status: "verified" },
    });
  });

  it("installs the production child seam on WorkGraphOrchestrator", async () => {
    const { graph } = adapter.orchestrator.decompose({
      parentTaskId: "parent",
      objective: "Run graph work",
      maxConcurrency: 1,
      units: [{ key: "worker", ownerId: targetId, ownerProfileHash: profileHash, objective: "Run the worker" }],
    });

    const dispatched = await adapter.orchestrator.dispatchReady(graph.id);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.childTaskId).toEqual(expect.any(String));
    expect(run).toHaveBeenCalledTimes(1);
    expect(adapter.findChildByAdmissionId(dispatched[0]!.admissionId!)).toBe(dispatched[0]!.childTaskId);
  });

  it("keeps team agents on the delegation-required policy path", async () => {
    teamsRepository(db).create({ id: "team-1", projectId: "project", name: "Team", createdAt: NOW });
    const teamAgent = agentsRepository(db).create({
      id: "team-worker",
      projectId: "project",
      name: "Team worker",
      role: "researcher",
      teamId: "team-1",
    });
    const teamHash = teammateProfileFingerprint(teamAgent, agentsRepository(db).listToolPermissions(teamAgent.id));

    await expect(adapter.dispatchChild(request({
      ownerId: teamAgent.id,
      ownerProfileHash: teamHash,
      policyFingerprint: policyFingerprint(teamAgent.id, teamHash),
      admissionId: "admission:graph-1:unit:team-worker",
      idempotencyKey: "admission:graph-1:unit:team-worker",
      unitId: "unit:team-worker",
    }))).rejects.toMatchObject({ code: "TEAM_AGENT_REQUIRES_DELEGATION" });
    expect(run).not.toHaveBeenCalled();
    expect(taskRepository(db).listChildren("parent")).toHaveLength(0);
  });
});
