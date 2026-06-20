import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { executeInspectWorkspaceTask } from "../src/execution/inspect-workspace.js";

const now = "2026-01-01T00:00:00.000Z";

describe("inspect workspace executor", () => {
  for (const [name, hook, expectedStep, expectsEvidence] of [
    ["evidence persistence", "beforeEvidencePersist", 1, false],
    ["verification persistence", "beforeVerificationPersist", 2, true],
    ["final verified transition", "beforeFinalTransition", 2, true],
  ] as const) it(`fails safely when ${name} fails`, () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-executor-failure-"));
    try {
      writeFileSync(join(root, "file.txt"), "content");
      const db = openDatabase(":memory:"); const projects = projectRepository(db); const tasks = taskRepository(db); const records = taskRecordsRepository(db);
      projects.createProject({ id: "project", name: "Project", workspacePath: root, createdAt: now }); tasks.createTask({ id: "task", projectId: "project", kind: "inspect_workspace", status: "queued", createdAt: now });
      expect(() => executeInspectWorkspaceTask({ db, taskId: "task", now: () => now, hooks: { [hook]: () => { throw new Error("forced"); } } })).toThrow("Workspace task failed");
      const aggregate = records.getAggregate("task");
      expect(aggregate.task.status).toBe("failed"); expect(aggregate.plan[expectedStep]?.status).toBe("failed");
      expect(aggregate.verification).toBeUndefined(); expect(aggregate.events.at(-1)?.type).toBe("task.failed");
      expect(aggregate.disclosure?.executionMode).toBe("deterministic-local"); expect(aggregate.evidence).toHaveLength(expectsEvidence ? 1 : 0); db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("marks active inspection step failed without a verified result", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-executor-failure-"));
    try {
      const db = openDatabase(":memory:"); const projects = projectRepository(db); const tasks = taskRepository(db); const records = taskRecordsRepository(db);
      projects.createProject({ id: "project", name: "Project", workspacePath: root, createdAt: now }); tasks.createTask({ id: "task", projectId: "project", kind: "inspect_workspace", status: "queued", createdAt: now });
      expect(() => executeInspectWorkspaceTask({ db, taskId: "task", now: () => now, inspect: () => { throw new Error("internal path leak"); } })).toThrow("Workspace task failed");
      const aggregate = records.getAggregate("task");
      expect(aggregate.task.status).toBe("failed"); expect(aggregate.plan[1]?.status).toBe("failed"); expect(aggregate.verification).toBeUndefined();
      expect(aggregate.events.at(-1)?.type).toBe("task.failed"); db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("persists verified aggregate from real workspace inspection", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-executor-"));
    const databaseDirectory = mkdtempSync(join(tmpdir(), "morrow-executor-db-"));
    const database = join(databaseDirectory, "state.db");
    try {
      mkdirSync(join(root, "nested")); mkdirSync(join(root, ".morrow"));
      writeFileSync(join(root, "nested", "file.txt"), "content"); writeFileSync(join(root, ".morrow", "morrow.db"), "private");
      const db = openDatabase(database); const projects = projectRepository(db); const tasks = taskRepository(db); const records = taskRecordsRepository(db);
      projects.createProject({ id: "project", name: "Project", workspacePath: root, createdAt: now });
      tasks.createTask({ id: "task", projectId: "project", kind: "inspect_workspace", status: "queued", createdAt: now });
      const aggregate = executeInspectWorkspaceTask({ db, taskId: "task", now: () => now });
      expect(aggregate.task.status).toBe("verified");
      expect(aggregate.plan.map((step) => step.status)).toEqual(["completed", "completed", "completed"]);
      expect(aggregate.evidence.map((item) => item.path)).toEqual(["nested/file.txt"]);
      expect(aggregate.disclosure).toMatchObject({ executionMode: "deterministic-local", provider: "deterministic-local", networkAccess: "disabled", filesystemAccess: "read-only", shellExecution: false, modelInvocation: false, workspaceScope: root, estimatedCostUsd: "$0.00" });
      expect(aggregate.verification?.details).toMatchObject({ resultCount: 1, depthTruncated: false, countTruncated: false, inaccessibleEntryCount: 0 });
      expect(aggregate.events.map((event) => event.sequence)).toEqual(aggregate.events.map((_, index) => index + 1));
      expect(aggregate.events.map((event) => event.type)).toEqual(["task.created", "plan.created", "task.running", "step.started", "step.completed", "step.started", "workspace.inspected", "evidence.persisted", "step.completed", "step.started", "verification.completed", "step.completed", "task.verified"]);
      db.close();
      const reopened = openDatabase(database); expect(taskRecordsRepository(reopened).getAggregate("task").task.status).toBe("verified"); reopened.close();
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); try { rmSync(databaseDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows may retain a short-lived SQLite file handle. */ } }
  });
});
