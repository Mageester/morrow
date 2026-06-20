import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { recoverRunningTasks } from "../src/recovery.js";

const now = "2026-01-01T00:00:00.000Z";

describe("restart recovery", () => {
  it("interrupts running tasks once and leaves other task states intact", () => {
    const db = openDatabase(":memory:"); const projects = projectRepository(db); const tasks = taskRepository(db);
    projects.createProject({ id: "p", name: "project", workspacePath: "C:/workspace", createdAt: now });
    for (const [id, status] of [["running", "running"], ["queued", "queued"], ["verified", "verified"], ["failed", "failed"], ["interrupted", "interrupted"]] as const) tasks.createTask({ id, projectId: "p", kind: "inspect_workspace", status, createdAt: now });
    const records = taskRecordsRepository(db);
    records.appendEvent({ id: "old", taskId: "running", type: "task.created", payload: {}, createdAt: now });
    expect(recoverRunningTasks(db, records, now)).toBe(1);
    expect(records.getAggregate("running").task.status).toBe("interrupted");
    expect(records.listEvents("running").map((event) => event.type)).toEqual(["task.created", "task.interrupted", "task.recovery_required"]);
    expect(recoverRunningTasks(db, records, now)).toBe(0);
    for (const id of ["queued", "verified", "failed", "interrupted"]) expect(records.getAggregate(id).task.status).toBe(id);
    db.close();
  });
});
