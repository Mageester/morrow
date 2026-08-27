import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { openDatabase, migrations } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { workGraphsRepository } from "../src/repositories/work-graphs.js";

const createdAt = "2026-08-27T12:00:00.000Z";

function seed(db: Database.Database, parentTaskId = "parent") {
  projectRepository(db).createProject({
    id: "project-1",
    name: "Project",
    workspacePath: "/tmp/project",
    createdAt,
  });
  taskRepository(db).createTask({
    id: parentTaskId,
    projectId: "project-1",
    kind: "agent_chat",
    status: "running",
    createdAt,
  });
}

describe("durable work graph migration", () => {
  it("adds graph, unit, dependency, and barrier state without replacing delegation tables", () => {
    expect(migrations.find((migration) => migration.id === 69))
      .toMatchObject({ id: 69, name: "durable_work_graphs" });

    const db = openDatabase(":memory:");
    seed(db);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
    expect(tables.has("work_graphs")).toBe(true);
    expect(tables.has("work_graph_units")).toBe(true);
    expect(tables.has("work_graph_dependencies")).toBe(true);
    expect(tables.has("delegations")).toBe(true);
    expect(tables.has("handoffs")).toBe(true);
    db.close();
  });

  it("upgrades a migration-68 database without rewriting tasks or delegation tables", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-work-graph-migration-"));
    const file = join(root, "legacy.db");
    try {
      const legacy = new Database(file);
      legacy.pragma("foreign_keys = ON");
      legacy.function("morrow_redact", { deterministic: true }, (value: unknown) => typeof value === "string" ? value : "");
      legacy.exec("CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
      const appliedAt = legacy.prepare("INSERT INTO schema_migrations(id,name,applied_at) VALUES(?,?,?)");
      for (const migration of migrations.filter((item) => item.id <= 68)) {
        legacy.transaction(() => {
          if (migration.sql) legacy.exec(migration.sql);
          if (migration.up) migration.up(legacy);
          appliedAt.run(migration.id, migration.name, createdAt);
        })();
      }
      legacy.prepare("INSERT INTO projects(id,schema_version,name,workspace_path,created_at,updated_at) VALUES(?,1,?,?,?,?)")
        .run("project-1", "Legacy", "/tmp/project", createdAt, createdAt);
      legacy.prepare("INSERT INTO tasks(id,schema_version,project_id,type,status,created_at,updated_at) VALUES(?,1,?,?,?,?,?)")
        .run("parent", "project-1", "agent_chat", "running", createdAt, createdAt);
      legacy.close();

      const upgraded = openDatabase(file);
      expect(taskRepository(upgraded).getTaskById("parent")?.status).toBe("running");
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM delegations").get()).toEqual({ count: 0 });
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM handoffs").get()).toEqual({ count: 0 });
      expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id=69").get()).toEqual({ id: 69 });
      upgraded.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("workGraphsRepository", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seed(db);
  });

  afterEach(() => db.close());

  it("suppresses a duplicate decomposition by parent-owned idempotency key", () => {
    const graphs = workGraphsRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 2, createdAt });

    const first = graphs.createUnit({
      id: "unit-a",
      graphId: "graph-1",
      parentTaskId: "parent",
      position: 1,
      idempotencyKey: "unit:research",
      ownerId: "agent-researcher",
      ownerProfileHash: "profile-v1",
      policyFingerprint: "policy-v1",
      objective: "Read the project README",
      createdAt,
    });
    const replay = graphs.createUnit({
      id: "different-id-is-not-created",
      graphId: "graph-1",
      parentTaskId: "parent",
      position: 1,
      idempotencyKey: "unit:research",
      ownerId: "agent-researcher",
      ownerProfileHash: "profile-v1",
      policyFingerprint: "policy-v1",
      objective: "Read the project README",
      createdAt: "2026-08-27T12:01:00.000Z",
    });

    expect(replay).toEqual(first);
    expect(graphs.listUnits("graph-1")).toHaveLength(1);
    expect(() => graphs.createUnit({
      id: "different-payload",
      graphId: "graph-1",
      parentTaskId: "parent",
      position: 1,
      idempotencyKey: "unit:research",
      ownerId: "agent-researcher",
      ownerProfileHash: "profile-v2",
      policyFingerprint: "policy-v1",
      objective: "A different objective",
      createdAt,
    })).toThrow(/idempotency/i);
  });

  it("keeps parent ownership, dependency release, and deterministic ordering durable", () => {
    const graphs = workGraphsRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 3, createdAt });
    graphs.createUnit({ id: "z", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "z", ownerId: "owner-z", ownerProfileHash: "hash-z", policyFingerprint: "policy-z", objective: "Z", createdAt });
    graphs.createUnit({ id: "a", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "a", ownerId: "owner-a", ownerProfileHash: "hash-a", policyFingerprint: "policy-a", objective: "A", createdAt });
    graphs.createUnit({ id: "b", graphId: "graph-1", parentTaskId: "parent", position: 2, idempotencyKey: "b", ownerId: "owner-b", ownerProfileHash: "hash-b", policyFingerprint: "policy-b", objective: "B", createdAt });
    graphs.addDependency("graph-1", "b", "a", createdAt);

    expect(graphs.listUnits("graph-1").map((unit) => unit.id)).toEqual(["a", "z", "b"]);
    expect(graphs.listReady("graph-1").map((unit) => unit.id)).toEqual(["a", "z"]);
    expect(graphs.get("graph-1")?.parentTaskId).toBe("parent");
    expect(() => graphs.addDependency("graph-1", "a", "b", createdAt)).toThrow(/cycle|dependency/i);

    expect(graphs.admit("graph-1", "a", "admitter-a", createdAt)?.status).toBe("admitted");
    expect(graphs.markTerminal("graph-1", "a", "succeeded", { summary: "read" }, createdAt).status).toBe("succeeded");
    expect(graphs.listReady("graph-1").map((unit) => unit.id)).toEqual(["z", "b"]);
    expect(graphs.get("graph-1")?.parentTaskId).toBe("parent");
  });

  it("creates a decomposition atomically when a dependency refers to a later unit", () => {
    const graphs = workGraphsRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 2, createdAt });
    const units = graphs.createUnits("graph-1", [
      { id: "first", parentTaskId: "parent", position: 1, idempotencyKey: "first", ownerId: "owner-first", objective: "First", dependsOn: ["later"], createdAt },
      { id: "later", parentTaskId: "parent", position: 2, idempotencyKey: "later", ownerId: "owner-later", objective: "Later", createdAt },
    ]);
    expect(units.map((unit) => unit.id)).toEqual(["first", "later"]);
    expect(graphs.createUnits("graph-1", [
      { id: "first", parentTaskId: "parent", position: 1, idempotencyKey: "first", ownerId: "owner-first", objective: "First", dependsOn: ["later"], createdAt: "2026-08-27T12:01:00.000Z" },
      { id: "later", parentTaskId: "parent", position: 2, idempotencyKey: "later", ownerId: "owner-later", objective: "Later", createdAt: "2026-08-27T12:01:00.000Z" },
    ])).toEqual(units);
    expect(graphs.listReady("graph-1").map((unit) => unit.id)).toEqual(["later"]);
    graphs.markTerminal("graph-1", "later", "succeeded", { answer: "later" }, createdAt);
    expect(graphs.listReady("graph-1").map((unit) => unit.id)).toEqual(["first"]);
  });

  it("enforces the admission cap with a durable conditional write", () => {
    const graphs = workGraphsRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 1, createdAt });
    for (const id of ["a", "b"]) {
      graphs.createUnit({ id, graphId: "graph-1", parentTaskId: "parent", position: id === "a" ? 1 : 2, idempotencyKey: id, ownerId: `owner-${id}`, ownerProfileHash: `hash-${id}`, policyFingerprint: `policy-${id}`, objective: id, createdAt });
    }

    const first = graphs.admit("graph-1", "a", "executor-a", createdAt);
    const second = graphs.admit("graph-1", "b", "executor-b", createdAt);
    expect(first?.status).toBe("admitted");
    expect(second).toBeNull();
    expect(graphs.get("graph-1")?.activeCount).toBe(1);

    graphs.markTerminal("graph-1", "a", "failed", { reason: "test" }, createdAt);
    expect(graphs.admit("graph-1", "b", "executor-b", createdAt)?.status).toBe("admitted");
    expect(graphs.get("graph-1")?.activeCount).toBe(1);
  });

  it("enforces the same cap across independent SQLite connections", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-work-graph-cas-"));
    const file = join(root, "graph.db");
    const firstDb = openDatabase(file);
    const secondDb = openDatabase(file);
    try {
      seed(firstDb);
      const first = workGraphsRepository(firstDb);
      const second = workGraphsRepository(secondDb);
      first.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 1, createdAt });
      first.createUnit({ id: "a", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "a", ownerId: "owner-a", objective: "A", createdAt });
      first.createUnit({ id: "b", graphId: "graph-1", parentTaskId: "parent", position: 2, idempotencyKey: "b", ownerId: "owner-b", objective: "B", createdAt });

      const firstAdmission = first.admit("graph-1", "a", "executor-a", createdAt);
      const secondAdmission = second.admit("graph-1", "b", "executor-b", createdAt);
      expect(firstAdmission?.status).toBe("admitted");
      expect(secondAdmission).toBeNull();
      expect(second.get("graph-1")?.activeCount).toBe(1);
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes overlapping WAL admission attempts across real processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-work-graph-overlap-"));
    const file = join(root, "graph.db");
    const gate = join(root, "start-gate");
    const firstDb = openDatabase(file);
    seed(firstDb);
    const first = workGraphsRepository(firstDb);
    first.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 1, createdAt });
    for (const id of ["a", "b"]) {
      first.createUnit({ id, graphId: "graph-1", parentTaskId: "parent", position: id === "a" ? 1 : 2, idempotencyKey: id, ownerId: `owner-${id}`, objective: id, createdAt });
    }
    firstDb.close();
    const databaseModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../src/database.ts")).href;
    const repositoryModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../src/repositories/work-graphs.ts")).href;
    const workerSource = `
      import { openDatabase } from ${JSON.stringify(databaseModule)};
      import { workGraphsRepository } from ${JSON.stringify(repositoryModule)};
      import { existsSync, writeFileSync } from "node:fs";
      writeFileSync(process.argv[5], "ready");
      while (!existsSync(process.argv[4])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      const db = openDatabase(process.argv[1]);
      const result = workGraphsRepository(db).admit("graph-1", process.argv[2], process.argv[3], "2026-08-27T12:00:00.000Z");
      process.stdout.write(result?.id ?? "null");
      db.close();
    `;
    const run = (unitId: string, ownerId: string) => {
      const readyFile = join(root, `${unitId}.ready`);
      let output = "";
      let error = "";
      const ready = new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (existsSync(readyFile)) { clearInterval(poll); resolve(); }
        }, 2);
      });
      const done = new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "-e", workerSource, file, unitId, ownerId, gate, readyFile], {
        cwd: dirname(dirname(fileURLToPath(import.meta.url))),
        stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
          code === 0 ? resolve(output.trim().split("\\n").at(-1) ?? "") : reject(new Error(error || `worker exited ${code}`));
        });
      });
      return { ready, done };
    };
    try {
      const runs = [run("a", "process-a"), run("b", "process-b")];
      await Promise.all(runs.map(({ ready }) => ready));
      writeFileSync(gate, "go");
      const results = await Promise.all(runs.map(({ done }) => done));
      expect(results.filter((id) => id !== "null")).toHaveLength(1);
      expect(results.filter((id) => id === "null")).toHaveLength(1);
      const verify = openDatabase(file);
      expect(verify.prepare("SELECT active_count FROM work_graphs WHERE id='graph-1'").get()).toEqual({ active_count: 1 });
      verify.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never advances a result cursor for a non-terminal unit", () => {
    const graphs = workGraphsRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 1, createdAt });
    graphs.createUnit({ id: "a", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "a", ownerId: "owner-a", ownerProfileHash: "hash-a", policyFingerprint: "policy-a", objective: "A", createdAt });

    expect(() => graphs.recordResult("graph-1", "a", { answer: "not yet" }, createdAt)).toThrow(/terminal/i);
    expect(graphs.getUnit("graph-1", "a")?.resultCursor).toBe(0);
    expect(() => db.prepare("UPDATE work_graph_units SET result_cursor=1 WHERE graph_id=? AND id=?").run("graph-1", "a"))
      .toThrow(/terminal/i);
    graphs.markTerminal("graph-1", "a", "succeeded", { answer: "done" }, createdAt);
    const recorded = graphs.recordResult("graph-1", "a", { answer: "done" }, createdAt);
    expect(recorded.resultCursor).toBe(1);
    expect(graphs.recordResult("graph-1", "a", { answer: "done" }, createdAt)).toEqual(recorded);
  });

  it("returns terminal fan-in in (position,id) order and claims the aggregate once", () => {
    const graphs = workGraphsRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 3, createdAt });
    graphs.createUnit({ id: "z", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "z", ownerId: "owner-z", ownerProfileHash: "hash-z", policyFingerprint: "policy-z", objective: "Z", createdAt });
    graphs.createUnit({ id: "a", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "a", ownerId: "owner-a", ownerProfileHash: "hash-a", policyFingerprint: "policy-a", objective: "A", createdAt });
    graphs.createUnit({ id: "b", graphId: "graph-1", parentTaskId: "parent", position: 2, idempotencyKey: "b", ownerId: "owner-b", ownerProfileHash: "hash-b", policyFingerprint: "policy-b", objective: "B", createdAt });
    graphs.markTerminal("graph-1", "z", "failed", { reason: "z" }, createdAt);
    graphs.markTerminal("graph-1", "a", "succeeded", { answer: "a" }, createdAt);
    expect(graphs.fanInReady("graph-1").ready).toBe(false);
    graphs.markTerminal("graph-1", "b", "blocked", { reason: "blocked" }, createdAt);

    const ready = graphs.fanInReady("graph-1");
    expect(ready.ready).toBe(true);
    expect(ready.units.map((unit) => unit.id)).toEqual(["a", "z", "b"]);
    graphs.recordResult("graph-1", "a", { answer: "a" }, createdAt);
    graphs.recordResult("graph-1", "z", { reason: "z" }, createdAt);
    graphs.recordResult("graph-1", "b", { reason: "blocked" }, createdAt);
    const claim = graphs.claimAggregate("graph-1", "aggregator-1", createdAt);
    expect(claim?.units.map((unit) => unit.id)).toEqual(["a", "z", "b"]);
    expect(graphs.claimAggregate("graph-1", "aggregator-2", createdAt)).toBeNull();
    expect(graphs.get("graph-1")?.fanInState).toBe("claimed");
  });

  it("requires imported terminal results before claiming fan-in and takes over an expired lease", () => {
    const graphs = workGraphsRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 2, createdAt });
    for (const id of ["a", "b"]) {
      graphs.createUnit({ id, graphId: "graph-1", parentTaskId: "parent", position: id === "a" ? 1 : 2, idempotencyKey: id, ownerId: `owner-${id}`, objective: id, createdAt });
      graphs.markTerminal("graph-1", id, "succeeded", { answer: id }, createdAt);
    }
    expect(graphs.claimAggregate("graph-1", "aggregator-1", createdAt, 60_000)).toBeNull();
    graphs.recordResult("graph-1", "a", { answer: "a" }, createdAt);
    graphs.recordResult("graph-1", "b", { answer: "b" }, createdAt);
    const first = graphs.claimAggregate("graph-1", "aggregator-1", createdAt, 60_000);
    expect(first?.ownerId).toBe("aggregator-1");
    const takeover = graphs.claimAggregate("graph-1", "aggregator-2", "2026-08-27T12:02:00.000Z", 60_000);
    expect(takeover?.ownerId).toBe("aggregator-2");
    expect(takeover?.claimId).not.toBe(first?.claimId);
  });

  it("rejects missing and conflicting terminal results after terminalization", () => {
    const graphs = workGraphsRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 1, createdAt });
    graphs.createUnit({ id: "a", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "a", ownerId: "owner-a", objective: "A", createdAt });
    expect(() => graphs.markTerminal("graph-1", "a", "succeeded", undefined, createdAt)).toThrow(/result/i);
    graphs.markTerminal("graph-1", "a", "succeeded", { answer: "done" }, createdAt);
    expect(() => graphs.markTerminal("graph-1", "a", "succeeded", { answer: "different" }, createdAt)).toThrow(/conflict|result/i);
    expect(() => db.prepare("UPDATE work_graph_units SET result_json=? WHERE id=?").run('{"answer":"tampered"}', "a"))
      .toThrow(/immutable|terminal|result/i);
  });

  it("retains owner, terminal, cursor, and claimed barrier state after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-work-graph-"));
    const file = join(root, "graph.db");
    try {
      const firstDb = openDatabase(file);
      seed(firstDb);
      const first = workGraphsRepository(firstDb);
      first.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 1, createdAt });
      first.createUnit({ id: "a", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "a", ownerId: "owner-a", ownerProfileHash: "hash-a", policyFingerprint: "policy-a", objective: "A", createdAt });
      first.markTerminal("graph-1", "a", "succeeded", { answer: "persisted" }, createdAt);
      first.recordResult("graph-1", "a", { answer: "persisted" }, createdAt);
      first.claimAggregate("graph-1", "aggregator-1", createdAt);
      firstDb.close();

      const reopened = openDatabase(file);
      const second = workGraphsRepository(reopened);
      expect(second.getUnit("graph-1", "a")).toMatchObject({ ownerId: "owner-a", status: "succeeded", resultCursor: 1 });
      expect(second.get("graph-1")).toMatchObject({ fanInState: "claimed", aggregateClaimOwner: "aggregator-1" });
      expect(second.claimAggregate("graph-1", "aggregator-2", createdAt)).toBeNull();
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attaches only a child owned by the parent and leaves child task truth unchanged", () => {
    const graphs = workGraphsRepository(db);
    const tasks = taskRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 1, createdAt });
    graphs.createUnit({ id: "a", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "a", ownerId: "owner-a", ownerProfileHash: "hash-a", policyFingerprint: "policy-a", objective: "A", createdAt });
    tasks.createTask({ id: "child", projectId: "project-1", kind: "inspect_workspace", status: "queued", parentTaskId: "parent", createdAt });
    expect(graphs.attachChild("graph-1", "a", "child", createdAt).childTaskId).toBe("child");
    expect(tasks.getTaskById("child")?.status).toBe("queued");
    expect(() => graphs.attachChild("graph-1", "a", "parent", createdAt)).toThrow(/child|parent/i);
  });

  it("persists an explicit role and serializes pre-spawn claims across connections", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-work-graph-claim-"));
    const file = join(root, "graph.db");
    const firstDb = openDatabase(file);
    const secondDb = openDatabase(file);
    try {
      seed(firstDb);
      const first = workGraphsRepository(firstDb);
      const second = workGraphsRepository(secondDb);
      first.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 1, createdAt });
      first.createUnit({ id: "review:quality", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "review:quality", ownerId: "reviewer", ownerProfileHash: "hash-reviewer", policyFingerprint: "policy-reviewer", objective: "Review", role: "review", createdAt });
      first.admit("graph-1", "review:quality", "dispatcher", createdAt, "admission:graph-1:review:quality");

      const claim = first.claimSpawn("graph-1", "review:quality", "dispatcher-a", createdAt, 60_000);
      expect(claim?.spawnClaimId).toBeTruthy();
      expect(claim?.role).toBe("review");
      expect(second.claimSpawn("graph-1", "review:quality", "dispatcher-b", createdAt, 60_000)).toBeNull();
      expect(second.claimSpawn("graph-1", "review:quality", "dispatcher-b", "2026-08-27T12:01:01.000Z", 60_000)?.spawnClaimId).toBeTruthy();
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists the aggregate result so completed synthesis replays without a callback", () => {
    const graphs = workGraphsRepository(db);
    graphs.create({ id: "graph-1", parentTaskId: "parent", maxConcurrency: 1, createdAt });
    graphs.createUnit({ id: "a", graphId: "graph-1", parentTaskId: "parent", position: 1, idempotencyKey: "a", ownerId: "owner-a", ownerProfileHash: "hash-a", policyFingerprint: "policy-a", objective: "A", createdAt });
    graphs.markTerminal("graph-1", "a", "verified", { answer: "a" }, createdAt);
    graphs.recordResult("graph-1", "a", { answer: "a" }, createdAt);
    const claim = graphs.claimAggregate("graph-1", "aggregator", createdAt);
    expect(claim).toBeTruthy();
    const result = { answer: "aggregate", source: "graph-1" };
    const completed = graphs.completeAggregate("graph-1", claim!.claimId, claim!.ownerId, createdAt, result);
    expect(completed?.aggregateResult).toEqual(result);
    expect(graphs.get("graph-1")?.aggregateResult).toEqual(result);
  });
});
