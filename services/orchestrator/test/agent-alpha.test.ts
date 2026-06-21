import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { MockProvider } from "../src/provider/mock.js";
import { TaskRunner } from "../src/runner.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { readWorkspaceFile, SafeReadError, validateSafeReadPath } from "../src/workspace/safe-reader.js";

describe("Agent Alpha", () => {
  let db: Database.Database;
  const tempDir = join(process.cwd(), "test-temp-workspace-" + Math.random().toString(36).substring(7));

  beforeEach(() => {
    // Isolated in-memory database for testing
    db = openDatabase(":memory:");
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Conversations & Messages Repository", () => {
    it("persists conversations and messages with deterministic ordering", () => {
      const projects = projectRepository(db);
      const convs = conversationsRepository(db);

      const project = projects.createProject({
        id: "p1",
        name: "Test Project",
        workspacePath: tempDir,
        createdAt: new Date().toISOString()
      });

      const conversation = convs.createConversation({
        id: "c1",
        projectId: project.id,
        title: "Test Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      expect(conversation.title).toBe("Test Chat");

      const t1 = new Date().toISOString();
      const m1 = convs.appendMessage({
        id: "m1",
        conversationId: "c1",
        role: "user",
        content: "Hello",
        createdAt: t1,
        updatedAt: t1
      });

      const t2 = new Date(Date.now() + 100).toISOString();
      const m2 = convs.appendMessage({
        id: "m2",
        conversationId: "c1",
        role: "assistant",
        content: "Hi there",
        createdAt: t2,
        updatedAt: t2,
        streamingState: "streaming"
      });

      const messages = convs.listMessages("c1");
      expect(messages.length).toBe(2);
      expect(messages[0]?.id).toBe("m1");
      expect(messages[1]?.id).toBe("m2");
      expect(messages[1]?.streamingState).toBe("streaming");

      // Update message
      convs.updateMessageContentAndState("m2", "Hi there, complete answer", "completed", new Date().toISOString());
      const updated = convs.getMessage("m2");
      expect(updated?.content).toBe("Hi there, complete answer");
      expect(updated?.streamingState).toBe("completed");
    });

    it("records tool calls with correct statuses and task/message associations", () => {
      const projects = projectRepository(db);
      const tasks = taskRepository(db);
      const convs = conversationsRepository(db);

      const project = projects.createProject({
        id: "p1",
        name: "Test Project",
        workspacePath: tempDir,
        createdAt: new Date().toISOString()
      });

      convs.createConversation({
        id: "c1",
        projectId: project.id,
        title: "Test Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      tasks.createTask({
        id: "task-1",
        projectId: "p1",
        kind: "agent_chat",
        status: "queued",
        createdAt: new Date().toISOString()
      });

      convs.appendMessage({
        id: "m1",
        conversationId: "c1",
        role: "user",
        content: "Hello",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const tc = convs.upsertToolCall({
        id: "call-1",
        messageId: "m1",
        taskId: "task-1",
        toolName: "read_file",
        argsJson: JSON.stringify({ path: "readme.md" }),
        status: "requested",
        createdAt: new Date().toISOString()
      });

      expect(tc.status).toBe("requested");

      convs.upsertToolCall({
        ...tc,
        status: "completed",
        resultJson: "file content summary",
        completedAt: new Date().toISOString()
      });

      const updated = convs.getToolCall("call-1");
      expect(updated?.status).toBe("completed");
      expect(updated?.resultJson).toBe("file content summary");
    });
  });

  describe("Safe Workspace Containment", () => {
    it("rejects file reads outside project workspace", () => {
      expect(() => {
        validateSafeReadPath(tempDir, "../secrets.txt");
      }).toThrow(SafeReadError);
    });

    it("rejects traversal and .morrow directory path elements", () => {
      expect(() => {
        validateSafeReadPath(tempDir, "src/../../outside.txt");
      }).toThrow(SafeReadError);

      expect(() => {
        validateSafeReadPath(tempDir, ".morrow/config.db");
      }).toThrow(SafeReadError);
    });

    it("rejects sensitive files, credentials, and keys", () => {
      writeFileSync(join(tempDir, "id_rsa"), "private key");
      writeFileSync(join(tempDir, ".env"), "API_KEY=123");
      writeFileSync(join(tempDir, "secret-token.txt"), "super-secret");

      expect(() => {
        validateSafeReadPath(tempDir, "id_rsa");
      }).toThrow(SafeReadError);

      expect(() => {
        validateSafeReadPath(tempDir, ".env");
      }).toThrow(SafeReadError);

      expect(() => {
        validateSafeReadPath(tempDir, "secret-token.txt");
      }).toThrow(SafeReadError);
    });

    it("rejects binary formats", () => {
      const binaryData = Buffer.from([0, 1, 2, 3, 4, 0, 5]);
      writeFileSync(join(tempDir, "data.bin"), binaryData);
      writeFileSync(join(tempDir, "image.png"), "PNG content");

      expect(() => {
        readWorkspaceFile(tempDir, "image.png");
      }).toThrow(SafeReadError);

      expect(() => {
        readWorkspaceFile(tempDir, "data.bin");
      }).toThrow(SafeReadError);
    });

    it("enforces raw byte limits (100 KB per file)", () => {
      const largeData = "x".repeat(1024 * 105); // 105 KB
      writeFileSync(join(tempDir, "large.txt"), largeData);

      expect(() => {
        readWorkspaceFile(tempDir, "large.txt", 102400);
      }).toThrow(SafeReadError);
    });
  });

  describe("MockProvider streaming workflows", () => {
    it("simulates E2E agent run successfully with read tools", async () => {
      const projects = projectRepository(db);
      const convs = conversationsRepository(db);
      const tasks = taskRepository(db);

      const project = projects.createProject({
        id: "p1",
        name: "Alpha Project",
        workspacePath: tempDir,
        createdAt: new Date().toISOString()
      });

      writeFileSync(join(tempDir, "readme.md"), "Morrow Architecture");
      writeFileSync(join(tempDir, "config.ts"), "export const product = 'Morrow';\n");

      const conversation = convs.createConversation({
        id: "c1",
        projectId: "p1",
        title: "Alpha Conversation",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      convs.appendMessage({
        id: "msg-user",
        conversationId: "c1",
        role: "user",
        content: "What is this repo about?",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const task = tasks.createTask({
        id: "task-1",
        projectId: "p1",
        kind: "agent_chat",
        status: "queued",
        createdAt: new Date().toISOString()
      });

      const assistantMsg = convs.appendMessage({
        id: "msg-assistant",
        conversationId: "c1",
        role: "assistant",
        content: "",
        taskId: "task-1",
        streamingState: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Prepare Mock Provider scenario
      const mockProvider = new MockProvider({
        chunks: [
          // Turn 0: LLM decides to call the tool
          [
            {
              type: "tool_call",
              toolCalls: [
                {
                  id: "search-call",
                  index: 0,
                  type: "function",
                  function: { name: "search_text", arguments: JSON.stringify({ query: "Morrow" }) }
                },
                {
                  id: "call-1",
                  index: 1,
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) }
                }
              ]
            },
            {
              type: "done"
            }
          ],
          // Turn 1: LLM sees tool output and answers
          [
            {
              type: "text",
              text: "Based on the readme, this is a "
            },
            {
              type: "text",
              text: "Morrow project."
            },
            {
              type: "done"
            }
          ]
        ]
      });

      await executeAgentChatTask({
        db,
        taskId: "task-1",
        provider: mockProvider
      });

      // Assert final task state is completed (truthful status)
      const finalTask = tasks.getTaskById("task-1");
      expect(finalTask?.status).toBe("completed");

      // Assert assistant message is fully stored and completed
      const finalMsg = convs.getMessage("msg-assistant");
      expect(finalMsg?.content).toBe("Based on the readme, this is a Morrow project.");
      expect(finalMsg?.streamingState).toBe("completed");

      // Assert tool calls and evidence are logged
      const toolCalls = convs.listToolCallsForMessage("msg-assistant");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls.map((call) => call.toolName)).toEqual(["search_text", "read_file"]);
      expect(toolCalls.every((call) => call.status === "completed")).toBe(true);

      const evidence = taskRecordsRepository(db).listEvidence("task-1");
      expect(evidence.length).toBe(1);
      expect(evidence[0]?.path).toBe("readme.md");
    });

    it("handles abort signals during streaming cancellation cleanly", async () => {
      const projects = projectRepository(db);
      const convs = conversationsRepository(db);
      const tasks = taskRepository(db);

      const project = projects.createProject({
        id: "p1",
        name: "Cancel Project",
        workspacePath: tempDir,
        createdAt: new Date().toISOString()
      });

      const conversation = convs.createConversation({
        id: "c1",
        projectId: "p1",
        title: "Cancel Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      convs.appendMessage({
        id: "msg-user",
        conversationId: "c1",
        role: "user",
        content: "Long prompt",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const task = tasks.createTask({
        id: "task-1",
        projectId: "p1",
        kind: "agent_chat",
        status: "queued",
        createdAt: new Date().toISOString()
      });

      const assistantMsg = convs.appendMessage({
        id: "msg-assistant",
        conversationId: "c1",
        role: "assistant",
        content: "",
        taskId: "task-1",
        streamingState: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const mockProvider = new MockProvider({
        chunks: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" }
        ],
        delayMs: 50
      });

      const abortController = new AbortController();

      // Trigger cancel after 20ms
      setTimeout(() => {
        abortController.abort();
      }, 20);

      await executeAgentChatTask({
        db,
        taskId: "task-1",
        provider: mockProvider,
        abortSignal: abortController.signal
      });

      const finalTask = tasks.getTaskById("task-1");
      expect(finalTask?.status).toBe("cancelled");

      const finalMsg = convs.getMessage("msg-assistant");
      expect(finalMsg?.streamingState).toBe("cancelled");
    });
  });
});
