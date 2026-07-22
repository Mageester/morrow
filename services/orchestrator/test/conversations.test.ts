import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { TaskRunner } from "../src/runner.js";
import { buildServer } from "../src/server.js";

const NOW = "2026-07-22T12:00:00.000Z";

describe("project-scoped conversation API", () => {
  let app: ReturnType<typeof buildServer>;
  let db: ReturnType<typeof openDatabase>;
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "morrow-conversations-"));
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "project-a", name: "A", workspacePath: workspace, createdAt: NOW });
    projectRepository(db).createProject({ id: "project-b", name: "B", workspacePath: workspace, createdAt: NOW });
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(workspace, { force: true, recursive: true });
  });

  async function create(title = "Durable chat") {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-a/conversations",
      payload: { title },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  it("creates, lists, gets, loads, renames, and archives only within the owning project", async () => {
    const conversation = await create();

    const listed = await app.inject({ method: "GET", url: "/api/projects/project-a/conversations" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ id: conversation.id, projectId: "project-a", title: "Durable chat" })]);

    const loaded = await app.inject({
      method: "GET",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
    });
    expect(loaded.statusCode).toBe(200);

    const messages = await app.inject({
      method: "GET",
      url: `/api/projects/project-a/conversations/${conversation.id}/messages`,
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toEqual([]);

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
      payload: { title: "Renamed chat" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().title).toBe("Renamed chat");

    const replayedRename = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
      payload: { title: "Renamed chat" },
    });
    expect(replayedRename.statusCode).toBe(200);
    expect(replayedRename.json().title).toBe("Renamed chat");

    const archive = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
      payload: { archived: true },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().archived).toBe(true);

    const replayedArchive = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-a/conversations/${conversation.id}`,
      payload: { archived: true },
    });
    expect(replayedArchive.statusCode).toBe(200);
    expect(replayedArchive.json().archived).toBe(true);

    const hidden = await app.inject({ method: "GET", url: "/api/projects/project-a/conversations" });
    expect(hidden.json()).toEqual([]);
    const archived = await app.inject({ method: "GET", url: "/api/projects/project-a/conversations?includeArchived=true" });
    expect(archived.json()).toHaveLength(1);

    for (const request of [
      { method: "GET", url: `/api/projects/project-b/conversations/${conversation.id}` },
      { method: "GET", url: `/api/projects/project-b/conversations/${conversation.id}/messages` },
      { method: "PATCH", url: `/api/projects/project-b/conversations/${conversation.id}`, payload: { title: "Stolen" } },
      { method: "PATCH", url: `/api/projects/project-b/conversations/${conversation.id}`, payload: { archived: false } },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    }
  });

  it("returns canonical persisted messages with truthful routing and safe tool summaries", async () => {
    const conversation = await create();
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    tasks.createTask({ id: "task-complete", projectId: "project-a", kind: "agent_chat", status: "completed", createdAt: NOW });
    conversations.appendMessage({ id: "user-message", conversationId: conversation.id, role: "user", content: "Question", createdAt: NOW, updatedAt: NOW });
    conversations.appendMessage({
      id: "assistant-message", conversationId: conversation.id, role: "assistant", content: "Canonical answer",
      taskId: "task-complete", streamingState: "completed", provider: "mock", model: "mock-model", createdAt: NOW, updatedAt: NOW,
    });
    conversations.upsertToolCall({
      id: "tool-call", messageId: "assistant-message", taskId: "task-complete", toolName: "read_file",
      argsJson: JSON.stringify({ path: "secret.txt", token: "must-not-leak" }), resultJson: "private artifact contents",
      status: "completed", createdAt: NOW, completedAt: NOW,
    });
    taskRoutingRepository(db).upsert({
      taskId: "task-complete", presetId: "balanced", providerId: "mock", model: "mock-model", useMemory: true,
      decision: {
        version: 1, presetId: "balanced", providerId: "mock", model: "mock-model", reason: "Deterministic test",
        fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "read-only", toolProfile: "read-only", autoApprove: false,
      },
      createdAt: NOW,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/project-a/conversations/${conversation.id}/messages`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body.find((entry: { id: string }) => entry.id === "assistant-message")).toMatchObject({
      id: "assistant-message",
      content: "Canonical answer",
      taskStatus: "completed",
      routing: { providerId: "mock", model: "mock-model", mode: "read-only" },
      toolActivity: [{ id: "tool-call", toolName: "read_file", status: "completed", startedAt: null, completedAt: NOW }],
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(JSON.stringify(body)).not.toContain("private artifact contents");
    expect(JSON.stringify(body)).not.toContain("secret.txt");
  });

  it("requires explicit confirmation, rejects deletion while a related task is active, and deletes dependents without deleting tasks or projects", async () => {
    const conversation = await create("Delete me");
    const other = await create("Keep me");
    const tasks = taskRepository(db);
    const conversations = conversationsRepository(db);
    tasks.createTask({ id: "active-task", projectId: "project-a", kind: "agent_chat", status: "running", createdAt: NOW });
    conversations.appendMessage({ id: "assistant-active", conversationId: conversation.id, role: "assistant", content: "Working", taskId: "active-task", streamingState: "streaming", createdAt: NOW, updatedAt: NOW });

    const unconfirmed = await app.inject({
      method: "DELETE", url: `/api/projects/project-a/conversations/${conversation.id}`, payload: {},
    });
    expect(unconfirmed.statusCode).toBe(400);

    const foreign = await app.inject({
      method: "DELETE", url: `/api/projects/project-b/conversations/${conversation.id}`, payload: { confirmation: "delete" },
    });
    expect(foreign.statusCode).toBe(404);

    const active = await app.inject({
      method: "DELETE", url: `/api/projects/project-a/conversations/${conversation.id}`, payload: { confirmation: "delete" },
    });
    expect(active.statusCode).toBe(409);
    expect(active.json().error.code).toBe("CONVERSATION_TASK_ACTIVE");
    expect(conversations.getConversation(conversation.id)).toBeDefined();

    taskRepository(db).updateTaskStatus("active-task", { status: "completed", updatedAt: NOW, completedAt: NOW });
    conversations.upsertToolCall({
      id: "dependent-tool", messageId: "assistant-active", taskId: "active-task", toolName: "read_file",
      argsJson: "{}", resultJson: "{}", status: "completed", createdAt: NOW, completedAt: NOW,
    });

    const deleted = await app.inject({
      method: "DELETE", url: `/api/projects/project-a/conversations/${conversation.id}`, payload: { confirmation: "delete" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ version: 1, conversationId: conversation.id, deleted: true });
    expect(conversations.getConversation(conversation.id)).toBeUndefined();
    expect(conversations.getMessage("assistant-active")).toBeUndefined();
    expect(conversations.getToolCall("dependent-tool")).toBeUndefined();
    expect(tasks.getTaskById("active-task")).toBeDefined();
    expect(projectRepository(db).getProjectById("project-a")).toBeDefined();
    expect(conversations.getConversation(other.id)).toBeDefined();

    const replay = await app.inject({
      method: "DELETE", url: `/api/projects/project-a/conversations/${conversation.id}`, payload: { confirmation: "delete" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ version: 1, conversationId: conversation.id, deleted: false });
  });
});
