import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

describe("idempotent task creation", () => {
  let db: any;
  let app: any;
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "morrow-idem-"));
    db = openDatabase(":memory:");
    // A no-op executor so created tasks settle without doing real work.
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
  });

  afterEach(() => {
    app.close();
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns the same task for a repeated Idempotency-Key and creates only one task", async () => {
    const headers = { "Idempotency-Key": "req-123" };
    const first = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", headers });
    expect(first.statusCode).toBe(202);
    const firstId = first.json().taskId;

    const second = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", headers });
    expect(second.statusCode).toBe(200);
    expect(second.json().taskId).toBe(firstId);
    expect(second.json().replayed).toBe(true);

    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);
  });

  it("creates distinct tasks for different keys and for no key", async () => {
    const a = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", headers: { "Idempotency-Key": "k-a" } });
    const b = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", headers: { "Idempotency-Key": "k-b" } });
    const c = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace" });
    const d = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace" });
    const ids = new Set([a, b, c, d].map((r) => r.json().taskId));
    expect(ids.size).toBe(4);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(4);
  });

  it("accepts the key from the request body as well as the header", async () => {
    const first = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", payload: { idempotencyKey: "body-key" } });
    const second = await app.inject({ method: "POST", url: "/api/projects/p1/tasks/inspect-workspace", payload: { idempotencyKey: "body-key" } });
    expect(first.json().taskId).toBe(second.json().taskId);
    expect(second.json().replayed).toBe(true);
  });
});

describe("idempotent agent-chat message send", () => {
  let db: any;
  let app: any;
  let ws: string;
  let conversationId: string;
  let prevMock: string | undefined;

  beforeEach(async () => {
    prevMock = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    ws = mkdtempSync(join(tmpdir(), "morrow-idem-chat-"));
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
    const conv = await app.inject({ method: "POST", url: "/api/projects/p1/conversations", payload: { title: "T" } });
    conversationId = conv.json().id;
  });

  afterEach(() => {
    if (prevMock === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = prevMock;
    app.close();
    db.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("replays the original task and messages instead of dispatching twice", async () => {
    const payload = { content: "hello there", idempotencyKey: "send-1" };
    const first = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();

    const second = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.task.id).toBe(firstBody.task.id);
    expect(secondBody.assistantMessage.id).toBe(firstBody.assistantMessage.id);
    expect(secondBody.userMessage.id).toBe(firstBody.userMessage.id);
    expect(secondBody.routing?.providerId).toBe("mock");

    // Exactly one task and one user/assistant message pair exist.
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);
    const msgs = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/messages` });
    expect(msgs.json()).toHaveLength(2);
  });

  it("honors the Idempotency-Key header on the message route too", async () => {
    const headers = { "Idempotency-Key": "send-h" };
    const first = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, headers, payload: { content: "hi" } });
    const second = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, headers, payload: { content: "hi" } });
    expect(second.statusCode).toBe(200);
    expect(second.json().task.id).toBe(first.json().task.id);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);
  });

  it("different keys and keyless sends still create distinct tasks", async () => {
    const a = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload: { content: "a", idempotencyKey: "ka" } });
    const b = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload: { content: "b", idempotencyKey: "kb" } });
    const c = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload: { content: "c" } });
    const ids = new Set([a, b, c].map((r) => r.json().task.id));
    expect(ids.size).toBe(3);
  });

  it("keeps the browser-scoped replay canonical and rejects key reuse for different content", async () => {
    const payload = { content: "same accepted attempt", idempotencyKey: "browser-attempt" };
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/p1/conversations/${conversationId}/messages`,
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/p1/conversations/${conversationId}/messages`,
      payload,
    });
    const conflict = await app.inject({
      method: "POST",
      url: `/api/projects/p1/conversations/${conversationId}/messages`,
      payload: { content: "different attempt", idempotencyKey: "browser-attempt" },
    });

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      replayed: true,
      task: { id: first.json().task.id },
      userMessage: { id: first.json().userMessage.id },
      assistantMessage: { id: first.json().assistantMessage.id },
    });
    expect(replay.json().sseUrl).toBe(`/api/projects/p1/conversations/${conversationId}/tasks/${first.json().task.id}/stream`);
    expect(replay.json().aggregateUrl).toBe(`/api/projects/p1/conversations/${conversationId}/messages`);
    expect(replay.json().routing).toMatchObject({ providerId: "mock", model: "mock-model" });
    expect(replay.json().routing).not.toHaveProperty("reason");
    expect(replay.json().routing).not.toHaveProperty("candidates");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(1);
    const messages = await app.inject({
      method: "GET",
      url: `/api/projects/p1/conversations/${conversationId}/messages`,
    });
    expect(messages.json()).toHaveLength(2);
  });

  it("rejects a browser send through a foreign project without dispatching", async () => {
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: ws, createdAt: new Date().toISOString() });
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/p2/conversations/${conversationId}/messages`,
      payload: { content: "do not dispatch", idempotencyKey: "foreign" },
    });
    expect(response.statusCode).toBe(404);
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(0);
    expect(taskRepository(db).listTasksByProject("p2")).toHaveLength(0);
  });
});
