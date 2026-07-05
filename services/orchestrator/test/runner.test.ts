import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { TaskRunner } from "../src/runner.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";

describe("TaskRunner", () => {
  let db: Database.Database;
  
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, schema_version INTEGER, name TEXT, workspace_path TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, schema_version INTEGER, project_id TEXT, type TEXT, status TEXT, idempotency_key TEXT, parent_task_id TEXT, agent_id TEXT, worktree_id TEXT, mission_id TEXT, created_at TEXT, updated_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE task_events (id TEXT PRIMARY KEY, schema_version INTEGER, task_id TEXT, sequence INTEGER, type TEXT, payload_json TEXT, created_at TEXT);
      CREATE TABLE agent_state_transitions (id TEXT PRIMARY KEY, schema_version INTEGER, task_id TEXT, sequence INTEGER, state TEXT, details_json TEXT, created_at TEXT);
      CREATE TABLE plan_steps (id TEXT PRIMARY KEY, schema_version INTEGER, task_id TEXT, position INTEGER, title TEXT, description TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE execution_disclosures (task_id TEXT PRIMARY KEY, schema_version INTEGER, execution_mode TEXT, provider TEXT, network_access TEXT, workspace_scope TEXT, estimated_cost_usd TEXT, created_at TEXT, updated_at TEXT, filesystem_access TEXT, shell_execution INTEGER, model_invocation INTEGER);
      CREATE TABLE task_evidence (id TEXT PRIMARY KEY, schema_version INTEGER, task_id TEXT, type TEXT, path TEXT, metadata_json TEXT, created_at TEXT);
      CREATE TABLE verification_results (task_id TEXT PRIMARY KEY, schema_version INTEGER, status TEXT, summary TEXT, details_json TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE conversation_messages (id TEXT PRIMARY KEY, task_id TEXT, content TEXT, streaming_state TEXT, updated_at TEXT);
    `);
    
    projectRepository(db).createProject({ id: "p1", name: "test", workspacePath: "/test", createdAt: new Date().toISOString() });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "inspect_workspace", status: "queued", createdAt: new Date().toISOString() });
  });

  afterEach(() => {
    db.close();
  });

  it("returns before gated executor completes and clears active on success", async () => {
    let releaseGate: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let executed = false;

    const runner = new TaskRunner(db, async () => {
      await gate;
      executed = true;
    });

    runner.run("t1");
    expect(executed).toBe(false);

    // Active state tracking
    const activeTasks = (runner as any).activeTasks;
    expect(activeTasks.has("t1")).toBe(true);

    // Rejects duplicate
    expect(() => runner.run("t1")).toThrow(/Duplicate/);

    // task.created is persisted synchronously
    const events = taskRecordsRepository(db).listEvents("t1");
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("task.created");

    // Release and wait
    releaseGate!();
    await runner.waitFor("t1");

    expect(executed).toBe(true);
    expect(activeTasks.has("t1")).toBe(false);
  });

  it("clears active on failure", async () => {
    const runner = new TaskRunner(db, async () => {
      throw new Error("mock failure");
    });

    runner.run("t1");
    await runner.waitFor("t1");
    
    const activeTasks = (runner as any).activeTasks;
    expect(activeTasks.has("t1")).toBe(false);
    expect(taskRepository(db).getTaskById("t1")?.status).toBe("failed");
    expect(taskRecordsRepository(db).listEvents("t1").at(-1)?.type).toBe("task.failed");
  });

  it("records failed agent state when an executor fails unexpectedly", async () => {
    const createdAt = new Date().toISOString();
    taskRepository(db).createTask({ id: "agent", projectId: "p1", kind: "agent_chat", status: "queued", createdAt });
    const records = taskRecordsRepository(db);
    records.transitionAgentState("agent", { id: "agent-idle", state: "idle", details: {}, createdAt });
    const runner = new TaskRunner(db, async () => {
      throw new Error("executor failure");
    });

    runner.run("agent");
    await runner.waitFor("agent");

    expect(records.getAgentState("agent")?.state).toBe("failed");
  });

  it("records cancelled agent state when a user cancels a running task", async () => {
    const createdAt = new Date().toISOString();
    taskRepository(db).createTask({ id: "agent", projectId: "p1", kind: "agent_chat", status: "queued", createdAt });
    const records = taskRecordsRepository(db);
    records.transitionAgentState("agent", { id: "agent-idle", state: "idle", details: {}, createdAt });
    const runner = new TaskRunner(db, async ({ abortSignal }) => {
      await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
    });

    runner.run("agent");
    runner.cancel("agent");

    expect(records.getAgentState("agent")?.state).toBe("cancelled");
  });
});
