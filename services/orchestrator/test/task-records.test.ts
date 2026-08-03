import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { redactSecretsDeep } from "../src/provider/credentials.js";

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

  it("redacts nested credential-like values before persisting task event payloads", () => {
    const { db, records } = setup();
    const probe = "credential sk-abcdefghijklmnop";
    const event = records.appendEvent({
      id: "secret-event",
      taskId: "t1",
      type: "assistant.turn_completed",
      payload: {
        text: probe,
        nested: { reasoning: probe, array: [probe, { value: probe }] },
      },
      createdAt,
    });

    expect(event.payload).toEqual({
      text: "credential ***redacted***",
      nested: { reasoning: "credential ***redacted***", array: ["credential ***redacted***", { value: "credential ***redacted***" }] },
    });
    expect(db.prepare("SELECT payload_json FROM task_events WHERE id=?").get("secret-event")).toEqual({
      payload_json: JSON.stringify(event.payload),
    });
    expect(JSON.stringify(records.listEvents("t1"))).not.toContain(probe);
    db.close();
  });

  it("preserves every entry when secret-shaped keys collide with the redaction marker", () => {
    const { db, records } = setup();
    const probe = "sk-abcdefghijklmnop";
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, probe, { enumerable: true, value: "secret-key value" });
    payload["***redacted***"] = "literal marker value";

    records.appendEvent({ id: "collision-event", taskId: "t1", type: "evidence.persisted", payload, createdAt });

    const raw = db.prepare("SELECT payload_json FROM task_events WHERE id=?").get("collision-event") as { payload_json: string };
    const expected = JSON.stringify(redactSecretsDeep(payload));
    expect(raw.payload_json).toBe(expected);
    expect(raw.payload_json).not.toContain(probe);
    expect(JSON.parse(raw.payload_json)).toEqual({
      "***redacted***": "secret-key value",
      "***redacted***#2": "literal marker value",
    });
    expect(JSON.stringify(redactSecretsDeep(payload))).toBe(expected);
    db.close();
  });

  it("persists a JSON-safe event when keys, serializers, accessors, cycles, and non-JSON values are hostile", () => {
    const { db, records } = setup();
    const probe = "credential sk-abcdefghijklmnop";
    let getterCalls = 0;
    const inherited = Object.create({ toJSON: () => ({ leaked: probe }) }) as Record<string, unknown>;
    Object.defineProperty(inherited, "visible", { enumerable: true, value: probe });
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, probe, { enumerable: true, value: probe });
    Object.defineProperty(payload, "toJSON", { enumerable: true, value: () => ({ leaked: probe }) });
    Object.defineProperty(payload, "getter", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return probe;
      },
    });
    payload.inherited = inherited;
    payload.bigint = BigInt(1);
    payload.symbol = Symbol(probe);
    payload.self = payload;

    const event = records.appendEvent({ id: "hostile-event", taskId: "t1", type: "assistant.turn_completed", payload, createdAt });
    const stored = db.prepare("SELECT payload_json FROM task_events WHERE id=?").get("hostile-event") as { payload_json: string };

    expect(getterCalls).toBe(0);
    expect(stored.payload_json).not.toContain(probe);
    expect(JSON.parse(stored.payload_json)).toEqual({
      "credential ***redacted***": "credential ***redacted***",
      toJSON: "[Unserializable]",
      getter: "[Unserializable]",
      inherited: { visible: "credential ***redacted***" },
      bigint: "[Unserializable]",
      symbol: "[Unserializable]",
      self: "[Circular]",
    });
    expect(() => JSON.stringify(event.payload)).not.toThrow();
    expect(JSON.stringify(event.payload)).not.toContain(probe);
    db.close();
  });

  it("executes the repository cursor query and reports its indexed SQLite plan for large histories", () => {
    const { db, records } = setup();
    const insert = db.prepare("INSERT INTO task_events(id,schema_version,task_id,sequence,type,payload_json,created_at) VALUES(?,1,?,?,?,?,?)");
    db.transaction(() => {
      for (let sequence = 1; sequence <= 10_000; sequence++) {
        insert.run(`seed-${sequence}`, "t1", sequence, "task.progress_warning", "{}", createdAt);
      }
    })();

    const preparedTaskEventSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (/^\s*SELECT \* FROM task_events\b/i.test(sql)) preparedTaskEventSql.push(sql);
      return statement;
    }) as typeof db.prepare;

    expect(records.listEventsAfter("t1", 9_995).map((event) => event.sequence)).toEqual([9_996, 9_997, 9_998, 9_999, 10_000]);
    expect(records.listEvents("t1", 9_998).map((event) => event.sequence)).toEqual([9_999, 10_000]);
    expect(preparedTaskEventSql).toHaveLength(2);
    expect(preparedTaskEventSql.every((sql) => /WHERE\s+task_id\s*=\s*\?\s+AND\s+sequence\s*>\s*\?/i.test(sql))).toBe(true);
    expect(preparedTaskEventSql.some((sql) => /WHERE\s+task_id\s*=\s*\?\s+ORDER\s+BY\s+sequence/i.test(sql))).toBe(false);

    type QueryDiagnostic = {
      explainEventsAfterQuery(taskId: string, afterSequence: number): { sql: string; plan: string[] };
    };
    const diagnostic = (records as unknown as QueryDiagnostic).explainEventsAfterQuery("t1", 9_995);
    expect(diagnostic.sql).toMatch(/WHERE\s+task_id\s*=\s*\?\s+AND\s+sequence\s*>\s*\?/i);
    expect(diagnostic.plan.join(" ")).toMatch(/SEARCH task_events USING (?:COVERING )?INDEX/i);
    expect(diagnostic.plan.join(" ")).toMatch(/task_id.*sequence/i);
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
    records.replacePlan("t1", [{ id: "s2", position: 2, title: "two", description: "two", status: "pending" }, { id: "s1", position: 1, title: "one", description: "one", status: "pending" }]);
    expect(records.listPlanSteps("t1").map((step) => step.id)).toEqual(["s1", "s2"]);
    expect(records.updatePlanStepStatus("s1", "completed", updatedAt)?.status).toBe("completed");
    expect(() => records.replacePlan("t1", [{ id: "x", position: 1, title: "x", description: "x", status: "pending" }, { id: "y", position: 1, title: "y", description: "y", status: "pending" }])).toThrow();
    db.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON plan_steps WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'no plan'); END");
    expect(() => records.replacePlan("t1", [{ id: "bad", position: 1, title: "bad", description: "bad", status: "pending" }])).toThrow("no plan");
    expect(records.listPlanSteps("t1").map((step) => step.id)).toEqual(["s1", "s2"]);
    db.close();
  });

  it("upserts disclosure and verification, ordering isolated evidence", () => {
    const { db, records } = setup();
    records.upsertDisclosure({ taskId: "t1", executionMode: "deterministic-local", provider: "deterministic-local", networkAccess: "disabled", filesystemAccess: "read-only", shellExecution: false, modelInvocation: false, workspaceScope: "C:/workspace", estimatedCostUsd: "$0.00", createdAt, updatedAt: createdAt });
    records.upsertDisclosure({ taskId: "t1", executionMode: "deterministic-local", provider: "deterministic-local", networkAccess: "disabled", filesystemAccess: "read-only", shellExecution: false, modelInvocation: false, workspaceScope: "C:/workspace", estimatedCostUsd: "$0.00", createdAt, updatedAt });
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
    initial.records.replacePlan("t1", [{ id: "step", position: 1, title: "step", description: "step", status: "pending" }]);
    initial.records.appendEvidence({ id: "evidence", taskId: "t1", type: "file", path: "file", metadata: {}, createdAt });
    initial.records.upsertDisclosure({ taskId: "t1", executionMode: "deterministic-local", provider: "deterministic-local", networkAccess: "disabled", filesystemAccess: "read-only", shellExecution: false, modelInvocation: false, workspaceScope: "C:/workspace", estimatedCostUsd: "$0.00", createdAt, updatedAt });
    initial.records.upsertVerification({ taskId: "t1", status: "verified", summary: "done", details: { truncated: false }, createdAt, updatedAt });
    initial.db.close();
    const reopened = openDatabase(file);
    const records = taskRecordsRepository(reopened);
    expect(records.getAggregate("t1").events).toHaveLength(1);
    expect(records.getAggregate("t1").disclosure?.provider).toBe("deterministic-local");
    expect(records.getAggregate("t1").verification?.summary).toBe("done");
    expect(records.getAggregate("t2").disclosure).toBeUndefined();
    expect(records.getAggregate("t2").verification).toBeUndefined();
    reopened.close();
    rmSync(dir, { recursive: true });
  });
});
