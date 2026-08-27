import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { buildServer } from "../src/server.js";
import { reconcileMissionsOnStartup } from "../src/recovery.js";
import { createWorkGraphIntegration, type WorkGraphIntegration } from "../src/mission/work-graph-integration.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskStartClaimsRepository } from "../src/repositories/task-start-claims.js";
import { workGraphsRepository } from "../src/repositories/work-graphs.js";
import { teammateProfileFingerprint } from "../src/tools/teammate-delegation.js";

const NOW = "2026-08-27T12:00:00.000Z";

function policyFingerprint(ownerId: string, ownerProfileHash: string): string {
  return `policy:${createHash("sha256")
    .update(JSON.stringify({ ownerId, ownerProfileHash }), "utf8")
    .digest("hex")}`;
}

/**
 * Drive one child to a real terminal, verified, canonically-answered state
 * through the production repositories the authoritative reader consults.
 */
function completeChildDurably(
  db: Database.Database,
  childTaskId: string,
  options: { reviewVerdict?: "approved" | "rejected" } = {},
): void {
  const records = taskRecordsRepository(db);
  const continuity = executionContinuityRepository(db);
  records.transitionTask(childTaskId, "running", { id: `running-${childTaskId}`, createdAt: NOW, payload: {} });
  records.appendEvidence({
    id: `evidence-${childTaskId}`,
    taskId: childTaskId,
    type: "file",
    path: `${childTaskId}.md`,
    metadata: { contentHash: createHash("sha256").update(childTaskId).digest("hex") },
    createdAt: NOW,
  });
  records.upsertVerification({
    taskId: childTaskId,
    status: "verified",
    summary: "passed",
    details: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
  const segment = continuity.openSegment({
    taskId: childTaskId,
    missionId: null,
    providerId: "mock",
    model: "mock-model",
    routeJson: {},
    ownerId: `worker-${childTaskId}`,
    now: NOW,
  });
  continuity.createCanonicalAnswer({
    id: `answer-${childTaskId}`,
    taskId: childTaskId,
    missionId: null,
    segmentId: segment.id,
    content: `Durable answer for ${childTaskId}`,
    evidenceJson: {
      sourceTurnKey: "final-turn",
      durableEventCursor: 2,
      requirementsSatisfied: true,
      status: "completed",
      ...(options.reviewVerdict ? { reviewVerdict: options.reviewVerdict } : {}),
    },
    ownerId: segment.ownerId!,
    generation: segment.generation,
    now: NOW,
  });
  db.prepare("UPDATE tasks SET status='completed',updated_at=?,completed_at=? WHERE id=?")
    .run(NOW, NOW, childTaskId);
}

interface Fixture {
  db: Database.Database;
  runner: TaskRunner;
  integration: WorkGraphIntegration;
  parentTaskId: string;
  workers: Array<{ id: string; hash: string }>;
  reviewer: { id: string; hash: string };
  directory: string;
  wokenMissions: string[];
  path: string;
}

const open: Fixture[] = [];
let previousMockProvider: string | undefined;

beforeEach(() => {
  previousMockProvider = process.env.MOCK_PROVIDER;
  process.env.MOCK_PROVIDER = "true";
});

function fixture(options: { wakeMission?: (missionId: string) => void } = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "morrow-work-graph-prod-"));
  const path = join(directory, "morrow.db");
  const db = openDatabase(path);
  projectRepository(db).createProject({ id: "project", name: "Project", workspacePath: directory, createdAt: NOW });
  taskRepository(db).createTask({ id: "parent", projectId: "project", kind: "agent_chat", status: "running", createdAt: NOW });
  const agents = agentsRepository(db);
  const make = (id: string) => {
    const agent = agents.create({ id, projectId: "project", name: id, role: "researcher", providerOverride: "mock", modelOverride: `${id}-model` });
    return { id: agent.id, hash: teammateProfileFingerprint(agent, agents.listToolPermissions(agent.id)) };
  };
  const workers = [make("research"), make("build")];
  const reviewer = make("quality");
  // A real TaskRunner with an executor that never returns on its own: each
  // test drives durable child state explicitly and then settles the task.
  const runner = new TaskRunner(db, async () => { /* child work is driven durably by the test */ });
  const wokenMissions: string[] = [];
  const integration = createWorkGraphIntegration({
    db,
    runner,
    wakeMission: options.wakeMission ?? ((missionId) => wokenMissions.push(missionId)),
  });
  const value: Fixture = { db, runner, integration, parentTaskId: "parent", workers, reviewer, directory, wokenMissions, path };
  open.push(value);
  return value;
}

afterEach(() => {
  for (const value of open.splice(0)) {
    value.integration.close();
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
  else process.env.MOCK_PROVIDER = previousMockProvider;
});

function decompose(value: Fixture) {
  return value.integration.orchestrator.decompose({
    parentTaskId: value.parentTaskId,
    objective: "Assemble a verified result from two workers and an independent review.",
    maxConcurrency: 2,
    units: value.workers.map((worker) => ({
      key: worker.id,
      ownerId: worker.id,
      ownerProfileHash: worker.hash,
      objective: `Do the ${worker.id} work`,
    })),
    reviewer: {
      key: value.reviewer.id,
      ownerId: value.reviewer.id,
      ownerProfileHash: value.reviewer.hash,
      objective: "Review the workers' result independently",
    },
  });
}

describe("work graph production integration", () => {
  it("reconciles a settled child through the runner settlement callback into fan-in", async () => {
    const value = fixture();
    const { graph } = decompose(value);

    const dispatched = await value.integration.orchestrator.dispatchReady(graph.id);
    expect(dispatched).toHaveLength(2);

    for (const unit of dispatched) {
      completeChildDurably(value.db, unit.childTaskId!);
      // Reconciliation is reached through the production settlement seam, not
      // by calling the orchestrator directly.
      await value.integration.reconcileChild(unit.childTaskId!);
    }

    const graphs = workGraphsRepository(value.db);
    const afterWorkers = graphs.listUnits(graph.id);
    expect(afterWorkers.filter((unit) => unit.status === "verified")).toHaveLength(2);
    // The reviewer's dependencies released, so it was dispatched by the same pass.
    const reviewerUnit = afterWorkers.find((unit) => unit.id.includes(value.reviewer.id))!;
    expect(reviewerUnit.childTaskId).toBeTruthy();
    expect(graphs.get(graph.id)?.fanInState).not.toBe("completed");

    completeChildDurably(value.db, reviewerUnit.childTaskId!, { reviewVerdict: "approved" });
    const settled = await value.integration.reconcileChild(reviewerUnit.childTaskId!);

    expect(settled).toMatchObject({ graphId: graph.id, synthesis: "completed", synthesizedNow: true });
    const completed = graphs.get(graph.id)!;
    expect(completed.fanInState).toBe("completed");
    // Ordered, durable fan-in over the required units.
    const aggregate = completed.aggregateResult as { units: Array<{ id: string; position: number }> };
    expect(aggregate.units.map((unit) => unit.id)).toEqual(graphs.listUnits(graph.id).map((unit) => unit.id));
    expect(value.integration.aggregateForParentTask(value.parentTaskId)).toMatchObject({ graphId: graph.id });
  });

  it("blocks synthesis when the independent review rejects", async () => {
    const value = fixture();
    const { graph } = decompose(value);
    const dispatched = await value.integration.orchestrator.dispatchReady(graph.id);
    for (const unit of dispatched) {
      completeChildDurably(value.db, unit.childTaskId!);
      await value.integration.reconcileChild(unit.childTaskId!);
    }
    const graphs = workGraphsRepository(value.db);
    const reviewerUnit = graphs.listUnits(graph.id).find((unit) => unit.id.includes(value.reviewer.id))!;
    completeChildDurably(value.db, reviewerUnit.childTaskId!, { reviewVerdict: "rejected" });

    const settled = await value.integration.reconcileChild(reviewerUnit.childTaskId!);

    expect(settled?.synthesis).not.toBe("completed");
    expect(settled?.reasons.length).toBeGreaterThan(0);
    expect(graphs.get(graph.id)?.fanInState).not.toBe("completed");
    expect(graphs.get(graph.id)?.aggregateResult).toBeNull();
  });

  it("resumes an unfinished graph through production startup reconciliation after a restart", async () => {
    const value = fixture();
    const { graph } = decompose(value);
    const dispatched = await value.integration.orchestrator.dispatchReady(graph.id);
    for (const unit of dispatched) completeChildDurably(value.db, unit.childTaskId!);
    const childIdsBeforeRestart = dispatched.map((unit) => unit.childTaskId!);
    // Abrupt stop: the children are durably terminal but were never imported.
    value.integration.close();
    value.db.close();

    const db = openDatabase(value.path);
    const runner = new TaskRunner(db, async () => { /* driven durably */ });
    const woken: string[] = [];
    const integration = createWorkGraphIntegration({ db, runner, wakeMission: (id) => woken.push(id) });
    const controllerRunner = { run: vi.fn(), wake: vi.fn(), isActive: () => false };
    open.push({ ...value, db, runner, integration });

    const summary = await reconcileMissionsOnStartup({ db, runner, controllerRunner, workGraphs: integration });

    expect(summary.workGraphsReconciled).toBe(1);
    const graphs = workGraphsRepository(db);
    const units = graphs.listUnits(graph.id);
    expect(units.filter((unit) => unit.status === "verified")).toHaveLength(2);
    // Restart imported the existing children rather than spawning new ones.
    expect(units.filter((unit) => unit.childTaskId && childIdsBeforeRestart.includes(unit.childTaskId))).toHaveLength(2);
    const reviewerUnit = units.find((unit) => unit.id.includes(value.reviewer.id))!;
    expect(reviewerUnit.childTaskId).toBeTruthy();
    expect(childIdsBeforeRestart).not.toContain(reviewerUnit.childTaskId);

    completeChildDurably(db, reviewerUnit.childTaskId!, { reviewVerdict: "approved" });
    const second = await reconcileMissionsOnStartup({ db, runner, controllerRunner, workGraphs: integration });
    expect(second.workGraphsReconciled).toBe(1);
    expect(graphs.get(graph.id)?.fanInState).toBe("completed");

    // A completed aggregate is never re-synthesized by a later startup.
    const aggregate = graphs.get(graph.id)!.aggregateResult;
    const third = await reconcileMissionsOnStartup({ db, runner, controllerRunner, workGraphs: integration });
    expect(third.workGraphsReconciled).toBe(0);
    expect(graphs.get(graph.id)!.aggregateResult).toEqual(aggregate);
  });

  it("reconciles a graph child from the runner's own settlement callback alongside the server", async () => {
    const value = fixture();
    // The server owns delegation settlement and the start fence on the same
    // runner; the graph integration subscribes independently. Both must
    // observe one settlement without fighting over it.
    const app = buildServer({ db: value.db, runner: value.runner });
    try {
      const { graph } = decompose(value);
      const dispatched = await value.integration.orchestrator.dispatchReady(graph.id);
      const [first] = dispatched;
      expect(taskStartClaimsRepository(value.db).get(first!.childTaskId!)).not.toBeNull();
      completeChildDurably(value.db, first!.childTaskId!);

      // Settlement is the production trigger; nothing calls the orchestrator.
      (value.runner as unknown as { notifySettled(taskId: string): void }).notifySettled(first!.childTaskId!);
      await value.integration.settled();

      const unit = workGraphsRepository(value.db).getUnit(graph.id, first!.id)!;
      expect(unit.status).toBe("verified");
      expect(unit.resultCursor).toBeGreaterThan(0);
      // Settlement also terminalized the durable start fence.
      expect(taskStartClaimsRepository(value.db).get(first!.childTaskId!)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("wakes the owning mission controller exactly once when fan-in completes", async () => {
    const value = fixture();
    value.db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project", "Graph mission", "running", 1, "{}", NOW, NOW);
    value.db.prepare("UPDATE tasks SET mission_id=? WHERE id=?").run("mission-1", value.parentTaskId);
    const { graph } = decompose(value);
    const dispatched = await value.integration.orchestrator.dispatchReady(graph.id);
    for (const unit of dispatched) {
      completeChildDurably(value.db, unit.childTaskId!);
      await value.integration.reconcileChild(unit.childTaskId!);
    }
    const reviewerUnit = workGraphsRepository(value.db).listUnits(graph.id)
      .find((unit) => unit.id.includes(value.reviewer.id))!;
    completeChildDurably(value.db, reviewerUnit.childTaskId!, { reviewVerdict: "approved" });

    await value.integration.reconcileChild(reviewerUnit.childTaskId!);
    // A second reconciliation of an already-completed graph must not re-wake.
    await value.integration.reconcileGraph(graph.id);

    expect(value.wokenMissions).toEqual(["mission-1"]);
  });

  it("ignores settlement of a task that is not a graph child", async () => {
    const value = fixture();
    taskRepository(value.db).createTask({ id: "loose", projectId: "project", kind: "agent_chat", status: "queued", createdAt: NOW });

    expect(await value.integration.reconcileChild("loose")).toBeNull();
    expect(await value.integration.reconcileChild("")).toBeNull();
  });
});
