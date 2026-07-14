import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { contextSummariesRepository } from "../src/repositories/context-summaries.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { AiProvider, ChatMessage, ProviderChunk } from "../src/provider/base.js";

describe("manual durable compaction", () => {
  it("keeps identical compacted projections isolated by task identity", () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-task-compact-scope-"));
    const db = openDatabase(":memory:");
    try {
      const at = new Date().toISOString();
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
      const conversations = conversationsRepository(db);
      conversations.createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
      taskRepository(db).createTask({ id: "t1", projectId: "p", kind: "agent_chat", status: "running", createdAt: at });
      taskRepository(db).createTask({ id: "t2", projectId: "p", kind: "agent_chat", status: "running", createdAt: at });
      const summaries = contextSummariesRepository(db);
      const common = { projectId: "p", conversationId: "c", method: "deterministic" as const, content: "SAME_SUMMARY", sourceStartIndex: 0, sourceEndIndex: 1, sourceMessageCount: 2, createdAt: at };

      summaries.record({ id: "s1", taskId: "t1", ...common });
      summaries.record({ id: "s2", taskId: "t2", ...common });

      expect(summaries.latestForTask("t1")?.id).toBe("s1");
      expect(summaries.latestForTask("t2")?.id).toBe("s2");
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("uses only the active task's compacted projection on resume", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-task-compact-resume-"));
    const db = openDatabase(":memory:");
    try {
      const at = new Date().toISOString();
      const after = (offset: number) => new Date(Date.parse(at) + offset).toISOString();
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
      const conversations = conversationsRepository(db);
      conversations.createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
      conversations.appendMessage({ id: "old-u", conversationId: "c", role: "user", content: "TASK_ONE_RAW", createdAt: after(1), updatedAt: after(1) });
      conversations.appendMessage({ id: "u", conversationId: "c", role: "user", content: "TASK_ONE_CURRENT", createdAt: after(2), updatedAt: after(2) });
      taskRepository(db).createTask({ id: "t1", projectId: "p", kind: "agent_chat", status: "queued", createdAt: after(3) });
      conversations.appendMessage({ id: "a1", conversationId: "c", role: "assistant", content: "", taskId: "t1", streamingState: "queued", createdAt: after(3), updatedAt: after(3) });
      contextSummariesRepository(db).record({
        id: "task-summary", projectId: "p", conversationId: "c", taskId: "t1",
        method: "deterministic", content: "TASK_ONE_DURABLE_SUMMARY", sourceStartIndex: 0,
        sourceEndIndex: 0, sourceMessageCount: 1, createdAt: at,
      });
      let sent: ChatMessage[] = [];
      const provider: AiProvider = { id: "mock", async *streamChat(messages): AsyncIterable<ProviderChunk> { sent = structuredClone(messages); yield { type: "text", text: "FINAL" }; yield { type: "done" }; } };

      await executeAgentChatTask({ db, taskId: "t1", provider });

      expect(JSON.stringify(sent)).toContain("TASK_ONE_DURABLE_SUMMARY");
      expect(JSON.stringify(sent)).not.toContain("TASK_ONE_RAW");
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("uses the saved summary in the next provider projection without replaying compacted raw messages", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-manual-compact-"));
    const db = openDatabase(":memory:");
    try {
      const at = new Date().toISOString();
      const after = (offset: number) => new Date(Date.parse(at) + offset).toISOString();
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: at });
      const conversations = conversationsRepository(db);
      conversations.createConversation({ id: "c", projectId: "p", title: "C", createdAt: at, updatedAt: at });
      conversations.appendMessage({ id: "old-u", conversationId: "c", role: "user", content: "RAW_PRIVATE_OLD_USER", createdAt: after(1), updatedAt: after(1) });
      conversations.appendMessage({ id: "old-a", conversationId: "c", role: "assistant", content: "RAW_PRIVATE_OLD_ASSISTANT", createdAt: after(2), updatedAt: after(2) });
      conversations.appendMessage({ id: "u", conversationId: "c", role: "user", content: "CURRENT_REQUEST", createdAt: after(3), updatedAt: after(3) });
      taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: after(4) });
      conversations.appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: after(4), updatedAt: after(4) });
      contextSummariesRepository(db).record({
        id: "summary", projectId: "p", conversationId: "c", taskId: null,
        method: "deterministic", content: "DURABLE_SUMMARY", sourceStartIndex: 0,
        sourceEndIndex: 1, sourceMessageCount: 2, createdAt: at,
      });
      let sent: ChatMessage[] = [];
      const provider: AiProvider = {
        id: "mock",
        async *streamChat(messages): AsyncIterable<ProviderChunk> {
          sent = structuredClone(messages);
          yield { type: "text", text: "FINAL" };
          yield { type: "done" };
        },
      };

      await executeAgentChatTask({ db, taskId: "t", provider });

      const serialized = JSON.stringify(sent);
      expect(serialized).toContain("DURABLE_SUMMARY");
      expect(serialized).toContain("CURRENT_REQUEST");
      expect(serialized).not.toContain("RAW_PRIVATE_OLD_USER");
      expect(serialized).not.toContain("RAW_PRIVATE_OLD_ASSISTANT");
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
