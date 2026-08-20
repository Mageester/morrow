import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { MockProvider } from "../src/provider/mock.js";
import type { ProviderChunk } from "../src/provider/base.js";
import { executeAgentChatTask } from "../src/execution/agent.js";

/**
 * Streamed assistant text is written through to durable storage on a flush
 * window rather than once per provider chunk. These tests are the contract that
 * window must never break: no text is lost, none is reordered, and the durable
 * message is complete once the stream ends — whatever the window is set to.
 */
describe("streamed assistant text persistence", () => {
  let db: Database.Database;
  let tempDir = "";

  beforeEach(() => {
    db = openDatabase(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "morrow-stream-coalesce-"));
  });
  afterEach(() => {
    try { db.close(); } finally {
      if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = ""; }
    }
  });

  function seed(): void {
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "Stream", workspacePath: tempDir, createdAt: ts });
    writeFileSync(join(tempDir, "readme.md"), "Morrow");
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "Stream", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "msg-user", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "task-1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "msg-assistant", conversationId: "c1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: ts, updatedAt: ts });
  }

  const WORDS = Array.from({ length: 400 }, (_value, index) => `token${index} `);

  function streamedTurn(): ProviderChunk[] {
    return WORDS.map((text) => ({ type: "text", text }) as ProviderChunk);
  }

  it("delivers every streamed chunk, in order, to both the durable message and the delta events", async () => {
    seed();
    const provider = new MockProvider({ chunks: [streamedTurn()] });
    await executeAgentChatTask({ db, taskId: "task-1", provider });

    const expected = WORDS.join("");
    const message = conversationsRepository(db).getMessage("msg-assistant");
    expect(message?.content).toContain(expected);

    const deltas = taskRecordsRepository(db)
      .listEvents("task-1")
      .filter((event) => event.type === "evidence.persisted")
      .map((event) => (event.payload as { deltaText?: string }).deltaText)
      .filter((text): text is string => typeof text === "string");
    expect(deltas.join("")).toBe(expected);
  });

  it("produces identical text with coalescing disabled", async () => {
    const previous = process.env.MORROW_STREAM_FLUSH_MS;
    process.env.MORROW_STREAM_FLUSH_MS = "0";
    try {
      seed();
      const provider = new MockProvider({ chunks: [streamedTurn()] });
      await executeAgentChatTask({ db, taskId: "task-1", provider });
      const deltas = taskRecordsRepository(db)
        .listEvents("task-1")
        .filter((event) => event.type === "evidence.persisted")
        .map((event) => (event.payload as { deltaText?: string }).deltaText)
        .filter((text): text is string => typeof text === "string");
      expect(deltas.join("")).toBe(WORDS.join(""));
      expect(deltas.length).toBe(WORDS.length);
    } finally {
      if (previous === undefined) delete process.env.MORROW_STREAM_FLUSH_MS;
      else process.env.MORROW_STREAM_FLUSH_MS = previous;
    }
  });

  it("writes far fewer durable delta events than provider chunks", async () => {
    seed();
    const provider = new MockProvider({ chunks: [streamedTurn()] });
    await executeAgentChatTask({ db, taskId: "task-1", provider });
    const deltaEvents = taskRecordsRepository(db)
      .listEvents("task-1")
      .filter((event) => event.type === "evidence.persisted" && typeof (event.payload as { deltaText?: string }).deltaText === "string");
    expect(deltaEvents.length).toBeLessThan(WORDS.length / 4);
  });
});
