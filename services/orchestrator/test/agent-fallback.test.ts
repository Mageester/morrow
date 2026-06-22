import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { AiProvider, ProviderChunk } from "../src/provider/base.js";

/** A provider that always fails to start with a retryable transport error. */
function throwingProvider(message: string): AiProvider {
  return {
    // eslint-disable-next-line require-yield
    async *streamChat(): AsyncIterable<ProviderChunk> {
      throw new Error(message);
    },
  } as unknown as AiProvider;
}

describe("agent live provider fallback", () => {
  let db: Database.Database;
  const tempDir = join(process.cwd(), "test-temp-fallback-" + Math.random().toString(36).slice(2));

  beforeEach(() => {
    db = openDatabase(":memory:");
    mkdirSync(tempDir, { recursive: true });
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "FB", workspacePath: tempDir, createdAt: ts });
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "FB", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c1", role: "assistant", content: "", taskId: "t1", streamingState: "queued", createdAt: ts, updatedAt: ts });
  });
  afterEach(() => {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("completes via the fallback provider when the primary fails to start, and records the fallback", async () => {
    const secondary = new MockProvider({ chunks: [[{ type: "text", text: "answer via fallback" }, { type: "done" }]] });
    (secondary as unknown as { id: string }).id = "secondary";

    await executeAgentChatTask({
      db,
      taskId: "t1",
      provider: throwingProvider("ECONNREFUSED"),
      fallbackProviders: [secondary],
    });

    expect(taskRepository(db).getTaskById("t1")?.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")?.content).toBe("answer via fallback");

    const events = taskRecordsRepository(db).listEvents("t1") as Array<{ type: string; payload: any }>;
    const fb = events.find((e) => e.type === "provider.fallback");
    expect(fb).toBeDefined();
    expect(fb!.payload.servedBy).toBe("secondary");
  });

  it("fails the task when the primary error is fatal (non-retryable) — no masking via fallback", async () => {
    const secondary = new MockProvider({ chunks: [[{ type: "text", text: "should not run" }, { type: "done" }]] });
    await executeAgentChatTask({
      db,
      taskId: "t1",
      provider: throwingProvider("400 Bad Request: invalid tool schema"),
      fallbackProviders: [secondary],
    });
    expect(taskRepository(db).getTaskById("t1")?.status).toBe("failed");
    expect(conversationsRepository(db).getMessage("ma")?.content).not.toContain("should not run");
  });
});
