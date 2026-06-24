import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";

describe("plan-only agent mode", () => {
  it("disables tool use and leaves no workspace evidence", async () => {
    const db = openDatabase(":memory:");
    const tempDir = join(process.cwd(), "test-temp-plan-mode-" + Math.random().toString(36).slice(2));
    mkdirSync(tempDir, { recursive: true });

    try {
      const projects = projectRepository(db);
      const conversations = conversationsRepository(db);
      const tasks = taskRepository(db);
      const routing = taskRoutingRepository(db);
      const records = taskRecordsRepository(db);

      projects.createProject({
        id: "p1",
        name: "Plan Project",
        workspacePath: tempDir,
        createdAt: new Date().toISOString(),
      });

      conversations.createConversation({
        id: "c1",
        projectId: "p1",
        title: "Plan Session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      conversations.appendMessage({
        id: "m-user",
        conversationId: "c1",
        role: "user",
        content: "Plan the refactor.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      tasks.createTask({
        id: "task-1",
        projectId: "p1",
        kind: "agent_chat",
        status: "queued",
        createdAt: new Date().toISOString(),
      });

      conversations.appendMessage({
        id: "m-assistant",
        conversationId: "c1",
        role: "assistant",
        content: "",
        taskId: "task-1",
        streamingState: "queued",
        provider: "mock",
        model: "mock-model",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      routing.upsert({
        taskId: "task-1",
        presetId: "balanced",
        providerId: "mock",
        model: "mock-model",
        useMemory: true,
        decision: {
          version: 1,
          presetId: "balanced",
          providerId: "mock",
          model: "mock-model",
          reason: "test",
          fallbackUsed: false,
          overridden: false,
          privacy: "cloud",
          candidates: [{ providerId: "mock", configured: true, reason: "test" }],
          mode: "plan-only",
          toolProfile: "none",
        },
        createdAt: new Date().toISOString(),
      });

      const provider = new MockProvider({
        chunks: [[{ type: "text", text: "1. Inspect current flow\n2. Define session model\n3. Add tests before edits" }, { type: "done" }]],
      });

      await executeAgentChatTask({ db, taskId: "task-1", provider });

      const aggregate = records.getAggregate("task-1");
      const toolCalls = conversations.listToolCallsForTask("task-1");
      const assistant = conversations.getMessage("m-assistant");

      expect(assistant?.content).toContain("Define session model");
      expect(toolCalls).toHaveLength(0);
      expect(aggregate.evidence).toHaveLength(0);
      expect(aggregate.task.status).toBe("completed");
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects provider tool calls without executing them in plan-only mode", async () => {
    const db = openDatabase(":memory:");
    const tempDir = join(process.cwd(), "test-temp-plan-mode-" + Math.random().toString(36).slice(2));
    mkdirSync(tempDir, { recursive: true });

    try {
      const projects = projectRepository(db);
      const conversations = conversationsRepository(db);
      const tasks = taskRepository(db);
      const routing = taskRoutingRepository(db);
      const records = taskRecordsRepository(db);

      projects.createProject({
        id: "p1",
        name: "Plan Project",
        workspacePath: tempDir,
        createdAt: new Date().toISOString(),
      });
      conversations.createConversation({
        id: "c1",
        projectId: "p1",
        title: "Plan Session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      conversations.appendMessage({
        id: "m-user",
        conversationId: "c1",
        role: "user",
        content: "Plan the refactor.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      tasks.createTask({
        id: "task-1",
        projectId: "p1",
        kind: "agent_chat",
        status: "queued",
        createdAt: new Date().toISOString(),
      });
      conversations.appendMessage({
        id: "m-assistant",
        conversationId: "c1",
        role: "assistant",
        content: "",
        taskId: "task-1",
        streamingState: "queued",
        provider: "mock",
        model: "mock-model",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      routing.upsert({
        taskId: "task-1",
        presetId: "balanced",
        providerId: "mock",
        model: "mock-model",
        useMemory: true,
        decision: {
          version: 1,
          presetId: "balanced",
          providerId: "mock",
          model: "mock-model",
          reason: "test",
          fallbackUsed: false,
          overridden: false,
          privacy: "cloud",
          candidates: [{ providerId: "mock", configured: true, reason: "test" }],
          mode: "plan-only",
          toolProfile: "none",
        },
        createdAt: new Date().toISOString(),
      });

      const provider = new MockProvider({
        chunks: [[{
          type: "tool_call",
          toolCalls: [{ id: "forbidden-call", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "evidence.txt" }) } }],
        }, { type: "done" }]],
      });

      await executeAgentChatTask({ db, taskId: "task-1", provider });

      expect(conversations.listToolCallsForTask("task-1")).toHaveLength(0);
      expect(records.getAggregate("task-1").evidence).toHaveLength(0);
      expect(records.getAggregate("task-1").task.status).toBe("failed");
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
