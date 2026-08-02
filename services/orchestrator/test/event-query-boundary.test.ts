import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { TaskRunner } from "../src/runner.js";

const repositoryInstances: Array<ReturnType<typeof taskRecordsRepository> & { listEvents: ReturnType<typeof vi.fn>; listEventsAfter: ReturnType<typeof vi.fn> }> = [];

vi.mock("../src/repositories/task-records.js", async () => {
  const actual = await vi.importActual<typeof import("../src/repositories/task-records.js")>("../src/repositories/task-records.js");
  return {
    ...actual,
    taskRecordsRepository: (db: Parameters<typeof actual.taskRecordsRepository>[0]) => {
      const real = actual.taskRecordsRepository(db);
      const wrapped = {
        ...real,
        listEvents: vi.fn(real.listEvents),
        listEventsAfter: vi.fn(real.listEventsAfter),
      } as ReturnType<typeof taskRecordsRepository> & { listEvents: ReturnType<typeof vi.fn>; listEventsAfter: ReturnType<typeof vi.fn> };
      repositoryInstances.push(wrapped);
      return wrapped;
    },
  };
});

let buildServer: typeof import("../src/server.js").buildServer;

beforeAll(async () => {
  ({ buildServer } = await import("../src/server.js"));
});

describe("task event cursor route boundary", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let workspacePath = "";

  beforeEach(() => {
    repositoryInstances.length = 0;
    workspacePath = mkdtempSync(join(tmpdir(), "morrow-event-query-"));
    db = openDatabase(":memory:");
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    db.close();
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it("uses the bounded repository cursor method for /events?after", async () => {
    const now = "2026-08-02T12:00:00.000Z";
    projectRepository(db).createProject({ id: "project-1", name: "Events", workspacePath, createdAt: now });
    taskRepository(db).createTask({ id: "task-1", projectId: "project-1", kind: "agent_chat", status: "running", createdAt: now });
    const records = taskRecordsRepository(db);
    records.appendEvent({ id: "event-1", taskId: "task-1", type: "task.progress_warning", payload: {}, createdAt: now });
    records.appendEvent({ id: "event-2", taskId: "task-1", type: "task.progress_warning", payload: {}, createdAt: now });

    app = buildServer({ db, runner: new TaskRunner(db) });
    const serverRecords = repositoryInstances.at(-1)!;
    const response = await app.inject({ method: "GET", url: "/api/tasks/task-1/events?after=1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().map((event: { id: string }) => event.id)).toEqual(["event-2"]);
    expect(serverRecords.listEventsAfter).toHaveBeenCalledWith("task-1", 1);
    expect(serverRecords.listEvents).not.toHaveBeenCalled();
  });

  it("uses the bounded repository cursor method for conversation SSE", async () => {
    const now = "2026-08-02T12:00:00.000Z";
    projectRepository(db).createProject({ id: "project-1", name: "Conversation", workspacePath, createdAt: now });
    conversationsRepository(db).createConversation({ id: "conversation-1", projectId: "project-1", title: "Conversation", createdAt: now, updatedAt: now });
    conversationsRepository(db).appendMessage({ id: "user-1", conversationId: "conversation-1", role: "user", content: "Finish the task.", createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: "task-1", projectId: "project-1", kind: "agent_chat", status: "queued", createdAt: now });
    conversationsRepository(db).appendMessage({ id: "assistant-1", conversationId: "conversation-1", role: "assistant", content: "done", taskId: "task-1", streamingState: "completed", createdAt: now, updatedAt: now });
    const records = taskRecordsRepository(db);
    records.transitionTask("task-1", "running", { id: "event-running", payload: {}, createdAt: now });
    records.transitionTask("task-1", "completed", { id: "event-completed", payload: {}, createdAt: now });

    app = buildServer({ db, runner: new TaskRunner(db), sseIntervalMs: 1 });
    const serverRecords = repositoryInstances.at(-1)!;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/project-1/conversations/conversation-1/tasks/task-1/stream?after=1`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("task.terminal");
    expect(serverRecords.listEventsAfter).toHaveBeenCalledWith("task-1", 1);
    expect(serverRecords.listEvents).not.toHaveBeenCalled();
  });
});
