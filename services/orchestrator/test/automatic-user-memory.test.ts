import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { AutomaticUserMemoryService } from "../src/cortex/automatic-user-memory.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { memoryRepository } from "../src/repositories/memory.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

describe("automatic user memory", () => {
  let db: Database.Database;
  let service: AutomaticUserMemoryService;

  beforeEach(() => {
    db = openDatabase(":memory:");
    const projects = projectRepository(db);
    projects.createProject({
      id: "project-a",
      name: "Project A",
      workspacePath: "C:\\project-a",
      createdAt: "2026-08-12T10:00:00.000Z",
    });
    projects.createProject({
      id: "project-b",
      name: "Project B",
      workspacePath: "C:\\project-b",
      createdAt: "2026-08-12T10:00:00.000Z",
    });
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "conversation-a", projectId: "project-a", title: "A", createdAt: "2026-08-12T10:00:00.000Z", updatedAt: "2026-08-12T10:00:00.000Z" });
    conversations.createConversation({ id: "conversation-a-2", projectId: "project-a", title: "A2", createdAt: "2026-08-12T10:00:00.000Z", updatedAt: "2026-08-12T10:00:00.000Z" });
    conversations.createConversation({ id: "conversation-b", projectId: "project-b", title: "B", createdAt: "2026-08-12T10:00:00.000Z", updatedAt: "2026-08-12T10:00:00.000Z" });
    const tasks = taskRepository(db);
    tasks.createTask({ id: "task-a", projectId: "project-a", kind: "agent_chat", status: "queued", createdAt: "2026-08-12T10:00:00.000Z" });
    tasks.createTask({ id: "task-b", projectId: "project-b", kind: "agent_chat", status: "queued", createdAt: "2026-08-12T10:00:00.000Z" });
    service = new AutomaticUserMemoryService(
      memoryRepository(db),
      () => "2026-08-12T10:01:00.000Z",
    );
  });

  it("learns explicit durable preferences without requiring a remember command", () => {
    const captured = service.capture({
      projectId: "project-a",
      conversationId: "conversation-a",
      messageId: "message-a",
      taskId: "task-a",
      content: "For UI work I prefer extremely minimal interfaces and I don't use gradients.",
    });

    expect(captured).toHaveLength(2);
    expect(captured).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "user_global",
        type: "user_preference",
        lifecycle: "active",
        source: "cortex",
        content: expect.stringMatching(/minimal interfaces/i),
      }),
      expect.objectContaining({
        scope: "user_global",
        type: "user_preference",
        lifecycle: "active",
        source: "cortex",
        content: expect.stringMatching(/gradients/i),
      }),
    ]));
    expect(captured.every((entry) => entry.evidenceReferences.some(
      (reference) => reference.kind === "user" && reference.reference === "message-a",
    ))).toBe(true);
  });

  it("keeps transient statements and likely secrets out of durable memory", () => {
    expect(service.capture({
      projectId: "project-a",
      conversationId: "conversation-a",
      messageId: "message-temporary",
      taskId: "task-a",
      content: "For this task I am temporarily using npm today.",
    })).toEqual([]);

    expect(service.capture({
      projectId: "project-a",
      conversationId: "conversation-a",
      messageId: "message-secret",
      taskId: "task-a",
      content: "Remember that API_KEY=super-secret-value-123456.",
    })).toEqual([]);

    expect(memoryRepository(db).listByProject("project-a")).toEqual([]);
  });

  it("consolidates equivalent preferences instead of appending near-duplicates", () => {
    service.capture({
      projectId: "project-a",
      conversationId: "conversation-a",
      messageId: "message-a",
      taskId: "task-a",
      content: "I don't use gradients.",
    });
    service.capture({
      projectId: "project-a",
      conversationId: "conversation-a-2",
      messageId: "message-b",
      taskId: "task-a",
      content: "I hate gradients.",
    });

    const gradients = memoryRepository(db).listUserGlobal()
      .filter((entry) => entry.normalizedContent.includes("gradients"));
    expect(gradients).toHaveLength(1);
    expect(gradients[0]?.evidenceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "message-a" }),
      expect.objectContaining({ reference: "message-b" }),
    ]));
  });

  it("updates a contradicted preference in place and preserves provenance", () => {
    const first = service.capture({
      projectId: "project-a",
      conversationId: "conversation-a",
      messageId: "message-light",
      taskId: "task-a",
      content: "I prefer light themes.",
    })[0]!;
    const second = service.capture({
      projectId: "project-a",
      conversationId: "conversation-a-2",
      messageId: "message-dark",
      taskId: "task-a",
      content: "I prefer dark themes.",
    })[0]!;

    expect(second.id).toBe(first.id);
    expect(second.content).toMatch(/dark themes/i);
    expect(second.content).not.toMatch(/light themes/i);
    expect(second.evidenceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "message-light" }),
      expect.objectContaining({ reference: "message-dark" }),
    ]));
    expect(memoryRepository(db).listUserGlobal()).toHaveLength(1);
  });

  it("recalls personal preferences in a different project but keeps project facts isolated", () => {
    service.capture({
      projectId: "project-a",
      conversationId: "conversation-a",
      messageId: "message-personal",
      taskId: "task-a",
      content: "I prefer minimal interfaces.",
    });
    service.capture({
      projectId: "project-a",
      conversationId: "conversation-a",
      messageId: "message-project",
      taskId: "task-a",
      content: "This repository always uses pnpm.",
    });

    const recalled = memoryRepository(db).retrieveRelevant(
      "project-b",
      "conversation-b",
      "Create a minimal interface and inspect the package manager",
      "2026-08-12T10:02:00.000Z",
    );
    expect(recalled.some((entry) => entry.scope === "user_global" && /minimal interfaces/i.test(entry.content))).toBe(true);
    expect(recalled.some((entry) => /pnpm/i.test(entry.content))).toBe(false);
  });
});
