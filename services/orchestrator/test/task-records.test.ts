import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";

const createdAt = "2026-01-01T00:00:00.000Z";
const updatedAt = "2026-01-01T00:01:00.000Z";

function setup(file = ":memory:") {
  const db = openDatabase(file);
  const projects = projectRepository(db);
  const tasks = taskRepository(db);
  projects.createProject({ id: "p", name: "project", workspacePath: "C:/workspace", createdAt });
  tasks.createTask({ id: "t1", projectId: "p", kind: "inspect_workspace", status: "queued", createdAt });
  tasks.createTask({ id: "t2", projectId: "p", kind: "inspect_workspace", status: "queued", createdAt });
  return { db, tasks, records: taskRecordsRepository(db) };
}

describe("task records repository", () => {
  it("appends ordered, task-local events and retrieves cursor pages", () => {
    const { db, tasks, records } = setup();
    const one = records.appendEvent({ id: "e1", taskId: "t1", type: "task.created", payload: {}, createdAt });
    const two = records.appendEvent({ id: "e2", taskId: "t1", type: "task.running", payload: { source: "test" }, createdAt: updatedAt });
    const other = records.appendEvent({ id: "e3", taskId: "t2", type: "task.created", payload: {}, createdAt });
    expect([one.sequence, two.sequence, other.sequence]).toEqual([1, 2, 1]);
    expect(records.listEvents("t1").map((event) => event.id)).toEqual(["e1", "e2"]);
    expect(records.listEvents("t1", 1).map((event) => event.id)).toEqual(["e2"]);
    db.close();
  });

  it("rejects malformed stored event payloads", () => {
    const { db, records } = setup();
    db.prepare("INSERT INTO task_events VALUES(?,?,?,?,?,?,?)").run("e", 1, "t1", 1, "task.created", "not-json", createdAt);
    expect(() => records.listEvents("t1")).toThrow();
    db.close();
  });

  it("enforces allowed transitions and appends matching events", () => {
    const { db, tasks, records } = setup();
    records.transitionTask("t1", "running", { id: "e1", createdAt: updatedAt, payload: {} });
    expect(tasks.getTaskById("t1")?.status).toBe("running");
    expect(records.listEvents("t1")[0]?.type).toBe("task.running");
    records.transitionTask("t1", "verified", { id: "e2", createdAt, payload: {} });
    expect(tasks.getTaskById("t1")?.status).toBe("verified");
    db.close();
  });

  it("permits each allowed transition", () => {
    const { db, tasks, records } = setup();
    records.transitionTask("t1", "failed", { id: "queued-failed", createdAt, payload: { message: "x" } });
    records.transitionTask("t2", "running", { id: "running", createdAt, payload: {} });
    records.transitionTask("t2", "failed", { id: "running-failed", createdAt, payload: { message: "x" } });
    tasks.createTask({ id: "t3", projectId: "p", kind: "inspect_workspace", status: "queued", createdAt });
    records.transitionTask("t3", "running", { id: "run-three", createdAt, payload: {} });
    records.transitionTask("t3", "interrupted", { id: "interrupt", createdAt, payload: {} });
    expect(records.getAggregate("t3").task.status).toBe("interrupted");
    db.close();
  });

  it("rejects every forbidden transition including same state", () => {
    const { db, tasks, records } = setup();
    expect(() => records.transitionTask("t1", "queued", { id: "same", createdAt, payload: {} })).toThrow();
    expect(() => records.transitionTask("t1", "verified", { id: "skip", createdAt, payload: {} })).toThrow();
    records.transitionTask("t1", "failed", { id: "failed", createdAt, payload: { message: "x" } });
    expect(() => records.transitionTask("t1", "verified", { id: "no", createdAt, payload: {} })).toThrow();
    tasks.createTask({ id: "verified", projectId: "p", kind: "inspect_workspace", status: "verified", createdAt });
    tasks.createTask({ id: "interrupted", projectId: "p", kind: "inspect_workspace", status: "interrupted", createdAt });
    expect(() => records.transitionTask("verified", "running", { id: "verified-running", createdAt, payload: {} })).toThrow();
    expect(() => records.transitionTask("interrupted", "verified", { id: "interrupted-verified", createdAt, payload: {} })).toThrow();
    db.close();
  });

  it("allows interrupted resume only through explicit method", () => {
    const { db, records } = setup();
    records.transitionTask("t1", "running", { id: "run", createdAt, payload: {} });
    records.transitionTask("t1", "interrupted", { id: "stop", createdAt, payload: {} });
    expect(() => records.transitionTask("t1", "running", { id: "no", createdAt, payload: {} })).toThrow();
    records.resumeInterruptedTask("t1", { id: "yes", createdAt, payload: {} });
    expect(records.getAggregate("t1").task.status).toBe("running");
    db.close();
  });

  it("rolls back transition task updates when event insertion fails", () => {
    const { db, tasks, records } = setup();
    db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'no event'); END");
    expect(() => records.transitionTask("t1", "running", { id: "e", createdAt, payload: {} })).toThrow("no event");
    expect(tasks.getTaskById("t1")?.status).toBe("queued");
    expect(records.listEvents("t1")).toEqual([]);
    db.close();
  });

  it("stores ordered plans and rolls replacement back on failure", () => {
    const { db, records } = setup();
    records.replacePlan("t1", [{ id: "s2", position: 2, title: "two", status: "pending" }, { id: "s1", position: 1, title: "one", status: "pending" }]);
    expect(records.listPlanSteps("t1").map((step) => step.id)).toEqual(["s1", "s2"]);
    expect(records.updatePlanStepStatus("s1", "completed", updatedAt)?.status).toBe("completed");
    expect(() => records.replacePlan("t1", [{ id: "x", position: 1, title: "x", status: "pending" }, { id: "y", position: 1, title: "y", status: "pending" }])).toThrow();
    db.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON plan_steps WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'no plan'); END");
    expect(() => records.replacePlan("t1", [{ id: "bad", position: 1, title: "bad", status: "pending" }])).toThrow("no plan");
    expect(records.listPlanSteps("t1").map((step) => step.id)).toEqual(["s1", "s2"]);
    db.close();
  });

  it("upserts disclosure and verification, ordering isolated evidence", () => {
    const { db, records } = setup();
    records.upsertDisclosure({ taskId: "t1", executionMode: "deterministic-local", provider: "built-in", networkAccess: "disabled", workspaceScope: "C:/workspace", estimatedCostUsd: "$0.00", createdAt, updatedAt: createdAt });
    records.upsertDisclosure({ taskId: "t1", executionMode: "deterministic-local", provider: "built-in", networkAccess: "disabled", workspaceScope: "C:/workspace", estimatedCostUsd: "$0.00", createdAt, updatedAt });
    records.appendEvidence({ id: "b", taskId: "t1", type: "file", path: "b", metadata: {}, createdAt: updatedAt });
    records.appendEvidence({ id: "a", taskId: "t1", type: "file", path: "a", metadata: { size: 1 }, createdAt });
    records.appendEvidence({ id: "other", taskId: "t2", type: "file", path: "x", metadata: {}, createdAt });
    records.upsertVerification({ taskId: "t1", status: "verified", summary: "done", details: { truncated: false }, createdAt, updatedAt });
    expect(records.getDisclosure("t1")?.updatedAt).toBe(updatedAt);
    expect(records.listEvidence("t1").map((item) => item.id)).toEqual(["a", "b"]);
    expect(records.listEvidence("t2").map((item) => item.id)).toEqual(["other"]);
    expect(records.getVerification("t1")?.details).toEqual({ truncated: false });
    expect(() => records.appendEvidence({ id: "bad", taskId: "t1", type: "file", path: "bad", metadata: [] as never, createdAt })).toThrow();
    expect(() => records.upsertVerification({ taskId: "t1", status: "verified", summary: "bad", details: [] as never, createdAt, updatedAt })).toThrow();
    db.close();
  });

  it("reconstructs complete and optional task aggregates after reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-records-"));
    const file = join(dir, "records.db");
    const initial = setup(file);
    initial.records.appendEvent({ id: "event", taskId: "t1", type: "task.created", payload: {}, createdAt });
    initial.records.replacePlan("t1", [{ id: "step", position: 1, title: "step", status: "pending" }]);
    initial.records.appendEvidence({ id: "evidence", taskId: "t1", type: "file", path: "file", metadata: {}, createdAt });
    initial.records.upsertDisclosure({ taskId: "t1", executionMode: "deterministic-local", provider: "built-in", networkAccess: "disabled", workspaceScope: "C:/workspace", estimatedCostUsd: "$0.00", createdAt, updatedAt });
    initial.records.upsertVerification({ taskId: "t1", status: "verified", summary: "done", details: { truncated: false }, createdAt, updatedAt });
    initial.db.close();
    const reopened = openDatabase(file);
    const records = taskRecordsRepository(reopened);
    expect(records.getAggregate("t1").events).toHaveLength(1);
    expect(records.getAggregate("t1").disclosure?.provider).toBe("built-in");
    expect(records.getAggregate("t1").verification?.summary).toBe("done");
    expect(records.getAggregate("t2").disclosure).toBeUndefined();
    expect(records.getAggregate("t2").verification).toBeUndefined();
    reopened.close();
    rmSync(dir, { recursive: true });
  });
});
