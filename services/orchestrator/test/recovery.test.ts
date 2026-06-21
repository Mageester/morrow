import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
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

  it("only interrupts queued or streaming messages tied to recovered tasks", () => {
    const db = openDatabase(":memory:");
    const projects = projectRepository(db);
    const tasks = taskRepository(db);
    const convs = conversationsRepository(db);
    const records = taskRecordsRepository(db);

    projects.createProject({ id: "p", name: "project", workspacePath: "C:/workspace", createdAt: now });
    tasks.createTask({ id: "running", projectId: "p", kind: "agent_chat", status: "running", createdAt: now });
    tasks.createTask({ id: "queued", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
    convs.createConversation({ id: "c1", projectId: "p", title: "one", createdAt: now, updatedAt: now });
    convs.createConversation({ id: "c2", projectId: "p", title: "two", createdAt: now, updatedAt: now });
    convs.appendMessage({ id: "m1", conversationId: "c1", role: "assistant", content: "", taskId: "running", streamingState: "streaming", createdAt: now, updatedAt: now });
    convs.appendMessage({ id: "m2", conversationId: "c2", role: "assistant", content: "", taskId: "queued", streamingState: "queued", createdAt: now, updatedAt: now });

    expect(recoverRunningTasks(db, records, now)).toBe(1);
    expect(convs.getMessage("m1")?.streamingState).toBe("interrupted");
    expect(convs.getMessage("m2")?.streamingState).toBe("queued");
    db.close();
  });
});
