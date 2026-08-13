import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { memoryRepository } from "../src/repositories/memory.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";

describe("agent automatic user memory", () => {
  let db: Database.Database;
  let root: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    root = mkdtempSync(join(tmpdir(), "morrow-auto-user-memory-"));
    projectRepository(db).createProject({ id: "p1", name: "One", workspacePath: root, createdAt: "2026-08-12T10:00:00.000Z" });
    projectRepository(db).createProject({ id: "p2", name: "Two", workspacePath: root, createdAt: "2026-08-12T10:00:00.000Z" });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function seedTurn(input: { taskId: string; conversationId: string; projectId: string; prompt: string }) {
    const now = "2026-08-12T10:00:00.000Z";
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: input.conversationId, projectId: input.projectId, title: input.prompt, createdAt: now, updatedAt: now });
    conversations.appendMessage({ id: `${input.taskId}-user`, conversationId: input.conversationId, role: "user", content: input.prompt, createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: input.taskId, projectId: input.projectId, kind: "agent_chat", status: "queued", createdAt: now });
    conversations.appendMessage({ id: `${input.taskId}-assistant`, conversationId: input.conversationId, role: "assistant", content: "", taskId: input.taskId, streamingState: "queued", createdAt: now, updatedAt: now });
  }

  it("learns from one normal turn and recalls the preference in a later project", async () => {
    seedTurn({ taskId: "t1", conversationId: "c1", projectId: "p1", prompt: "I don't use gradients." });
    await executeAgentChatTask({
      db,
      taskId: "t1",
      provider: new MockProvider({ chunks: [[{ type: "text", text: "Understood." }, { type: "done" }]] }),
      maxTurns: 2,
    });

    const learned = memoryRepository(db).listUserGlobal();
    expect(learned).toEqual([
      expect.objectContaining({ content: expect.stringMatching(/gradients/i), source: "cortex", scope: "user_global" }),
    ]);

    seedTurn({ taskId: "t2", conversationId: "c2", projectId: "p2", prompt: "How should I design the gradients in this interface?" });
    const laterProvider = new MockProvider({ chunks: [[{ type: "text", text: "Keep the interface restrained." }, { type: "done" }]] });
    await executeAgentChatTask({ db, taskId: "t2", provider: laterProvider, maxTurns: 2 });

    const prompt = laterProvider.requests[0]!.map((message) => message.content).join("\n");
    expect(prompt).toContain("Relevant saved memory");
    expect(prompt).toContain("I don't use gradients");
  });

  it("honors the local auto-memory opt-out", async () => {
    db.prepare("INSERT INTO settings(key, value) VALUES(?, ?)").run("memory.autoCapture", "false");
    seedTurn({ taskId: "t-opt-out", conversationId: "c-opt-out", projectId: "p1", prompt: "I prefer maximalist interfaces." });

    await executeAgentChatTask({
      db,
      taskId: "t-opt-out",
      provider: new MockProvider({ chunks: [[{ type: "text", text: "Understood." }, { type: "done" }]] }),
      maxTurns: 2,
    });

    expect(memoryRepository(db).listUserGlobal()).toEqual([]);
  });
});
