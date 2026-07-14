import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { symbolIndexRepository } from "../src/repositories/symbols.js";
import { MockProvider } from "../src/provider/mock.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "../src/provider/base.js";
import { TaskRunner } from "../src/runner.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { readWorkspaceFile, SafeReadError, validateSafeReadPath } from "../src/workspace/safe-reader.js";
import { SymbolIndex } from "../src/workspace/symbol-index.js";

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
    it("allows bounded reads of project log files", () => {
      writeFileSync(join(tempDir, "test-run.log"), "line one\nline two\n");
      expect(readWorkspaceFile(tempDir, "test-run.log")).toMatchObject({
        path: "test-run.log",
        content: "line one\nline two\n",
      });
    });

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
      writeFileSync(join(tempDir, "credentials.json"), '{"apiKey":"abc"}');
      writeFileSync(join(tempDir, ".npmrc"), "//registry.npmjs.org/:_authToken=abc");

      expect(() => {
        validateSafeReadPath(tempDir, "id_rsa");
      }).toThrow(SafeReadError);

      expect(() => {
        validateSafeReadPath(tempDir, ".env");
      }).toThrow(SafeReadError);

      expect(() => {
        validateSafeReadPath(tempDir, "credentials.json");
      }).toThrow(SafeReadError);

      expect(() => {
        validateSafeReadPath(tempDir, ".npmrc");
      }).toThrow(SafeReadError);
    });

    it("allows ordinary files that merely mention a security-related word in their name (fix: was a broad 'secret'/'credential'/'password' substring match — blocked secret-token.txt, secrets.js, credential-detector.test.js, keymap.ts, etc.)", () => {
      writeFileSync(join(tempDir, "secret-token.txt"), "not actually a credential store");
      writeFileSync(join(tempDir, "secrets.js"), "export const checks = [];\n");
      writeFileSync(join(tempDir, "credential-detector.test.js"), "test('detects', () => {});\n");

      expect(() => validateSafeReadPath(tempDir, "secret-token.txt")).not.toThrow();
      expect(() => validateSafeReadPath(tempDir, "secrets.js")).not.toThrow();
      expect(() => validateSafeReadPath(tempDir, "credential-detector.test.js")).not.toThrow();
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

    it("distinguishes fresh vs cached vs output tokens per response and folds them into a cumulative total exactly once each, never inventing a cached count the provider didn't report", async () => {
      const projects = projectRepository(db);
      const convs = conversationsRepository(db);
      const tasks = taskRepository(db);
      const records = taskRecordsRepository(db);

      projects.createProject({ id: "p1", name: "Usage Project", workspacePath: tempDir, createdAt: new Date().toISOString() });
      convs.createConversation({ id: "c1", projectId: "p1", title: "Usage Chat", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      convs.appendMessage({ id: "msg-user", conversationId: "c1", role: "user", content: "Do two things", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      tasks.createTask({ id: "task-1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
      convs.appendMessage({ id: "msg-assistant", conversationId: "c1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      // Turn 1 reports a cached-token breakdown; turn 2 reports usage but no
      // cached breakdown at all (a provider that simply never sends one).
      const mockProvider = new MockProvider({
        chunks: [
          [
            { type: "tool_call", toolCalls: [{ id: "call-1", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) } }] },
            { type: "done", usage: { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 30 } },
          ],
          [
            { type: "text", text: "Done." },
            { type: "done", usage: { promptTokens: 150, completionTokens: 40 } },
          ],
        ],
      });
      writeFileSync(join(tempDir, "readme.md"), "hi");

      await executeAgentChatTask({ db, taskId: "task-1", provider: mockProvider });

      const usageEvents = records.listEvents("task-1").filter((event) => event.type === "provider.usage");
      expect(usageEvents).toHaveLength(2);

      const first = usageEvents[0]!.payload as Record<string, unknown>;
      // Current-request accounting: fresh is separate from cached, and
      // separate from output, because this response DID report a breakdown.
      expect(first.totalInputTokens).toBe(100);
      expect(first.freshInputTokens).toBe(70); // 100 - 30 cached
      expect(first.cachedInputTokens).toBe(30);
      expect(first.outputTokens).toBe(20);
      expect(first.inputTokens).toBe(100); // legacy total-input display field
      expect(first.cacheBreakdownStatus).toBe("reported");
      expect(first.tokenSource).toBe("provider-reported");
      expect(first.tokenConfidence).toBe("exact");
      // Cumulative after exactly one, fully-reported response.
      expect(first.cumulativeResponseCount).toBe(1);
      expect(first.cumulativeTotalInputTokens).toBe(100);
      expect(first.cumulativeKnownFreshInputTokens).toBe(70);
      expect(first.cumulativeKnownCachedInputTokens).toBe(30);
      expect(first.cumulativeOutputTokens).toBe(20);
      expect(first.cumulativeCacheBreakdownComplete).toBe(true);

      const second = usageEvents[1]!.payload as Record<string, unknown>;
      // This response's provider never reported a cached breakdown at all.
      // The total input is still known, but fresh/cached must BOTH be
      // absent — never inferred as "150 fresh, 0 cached".
      expect(second.totalInputTokens).toBe(150);
      expect(second.inputTokens).toBe(150); // legacy total-input display field
      expect(second.freshInputTokens).toBeUndefined();
      expect(second.cachedInputTokens).toBeUndefined();
      expect(second.cacheBreakdownStatus).toBe("unavailable");
      expect(second.outputTokens).toBe(40);
      // Cumulative total input is a complete, exact sum regardless of the
      // breakdown gap. But the moment one response lacks a cache breakdown,
      // the cumulative split can no longer be presented as exact/complete —
      // the known fresh/cached subtotals freeze at what the first response
      // contributed, they do not grow to a false "220/30" split.
      expect(second.cumulativeResponseCount).toBe(2);
      expect(second.cumulativeTotalInputTokens).toBe(250); // 100 + 150
      expect(second.cumulativeOutputTokens).toBe(60); // 20 + 40
      expect(second.cumulativeCacheBreakdownComplete).toBe(false);
      expect(second.cumulativeKnownFreshInputTokens).toBe(70); // frozen from response 1 only
      expect(second.cumulativeKnownCachedInputTokens).toBe(30); // frozen from response 1 only
    });

    it("projects each assistant turn once instead of recursively copying prior narration", async () => {
      const projects = projectRepository(db);
      const convs = conversationsRepository(db);
      const tasks = taskRepository(db);
      projects.createProject({ id: "p1", name: "Projection", workspacePath: tempDir, createdAt: new Date().toISOString() });
      writeFileSync(join(tempDir, "one.txt"), "one");
      writeFileSync(join(tempDir, "two.txt"), "two");
      convs.createConversation({ id: "c1", projectId: "p1", title: "Projection", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      convs.appendMessage({ id: "msg-user", conversationId: "c1", role: "user", content: "Read both files", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      tasks.createTask({ id: "task-1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
      convs.appendMessage({ id: "msg-assistant", conversationId: "c1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      const requests: ChatMessage[][] = [];
      let call = 0;
      const provider: AiProvider = {
        id: "mock",
        async *streamChat(messages): AsyncIterable<ProviderChunk> {
          requests.push(structuredClone(messages));
          if (call++ === 0) {
            yield { type: "text", text: "NARRATION_ONE" };
            yield { type: "tool_call", toolCalls: [{ id: "read-one", index: 0, type: "function", function: { name: "read_file", arguments: '{"path":"one.txt"}' } }] };
          } else if (call === 2) {
            yield { type: "text", text: "NARRATION_TWO" };
            yield { type: "tool_call", toolCalls: [{ id: "read-two", index: 0, type: "function", function: { name: "read_file", arguments: '{"path":"two.txt"}' } }] };
          } else {
            yield { type: "text", text: "FINAL_ANSWER" };
          }
          yield { type: "done" };
        },
      };

      await executeAgentChatTask({ db, taskId: "task-1", provider });

      const thirdAssistantTurns = requests[2]!.filter((message) => message.role === "assistant");
      expect(thirdAssistantTurns.map((message) => message.content)).toEqual(["NARRATION_ONE", "NARRATION_TWO"]);
      expect(requests[2]!.filter((message) => message.role === "tool")).toHaveLength(2);
      expect(requests[2]!.map((message) => message.content).join("\n").match(/NARRATION_ONE/g)).toHaveLength(1);
    });

    it("exposes search_symbols in read-only mode and returns concise indexed locations", async () => {
      const projects = projectRepository(db);
      const convs = conversationsRepository(db);
      const tasks = taskRepository(db);
      const routing = taskRoutingRepository(db);

      writeFileSync(join(tempDir, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
      projects.createProject({ id: "p1", name: "Symbols", workspacePath: tempDir, createdAt: new Date().toISOString() });
      new SymbolIndex(symbolIndexRepository(db)).rebuildProject("p1", tempDir);

      convs.createConversation({ id: "c1", projectId: "p1", title: "Symbols", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      convs.appendMessage({ id: "msg-user", conversationId: "c1", role: "user", content: "Where is add?", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      tasks.createTask({ id: "task-symbols", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
      convs.appendMessage({ id: "msg-assistant", conversationId: "c1", role: "assistant", content: "", taskId: "task-symbols", streamingState: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      routing.upsert({
        taskId: "task-symbols",
        presetId: "balanced",
        providerId: "mock",
        model: "mock-model",
        useMemory: true,
        createdAt: new Date().toISOString(),
        decision: {
          version: 1,
          presetId: "balanced",
          providerId: "mock",
          model: "mock-model",
          reason: "test",
          fallbackUsed: false,
          overridden: false,
          privacy: "cloud",
          candidates: [],
          mode: "read-only",
          toolProfile: "read-only",
        },
      });

      let exposedTools: string[] = [];
      let turn = 0;
      const provider: AiProvider = {
        async *streamChat(_messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
          exposedTools = (options.tools ?? []).map((tool) => tool.name);
          if (turn++ === 0 && exposedTools.includes("search_symbols")) {
            yield { type: "tool_call", toolCalls: [{ id: "symbol-call", index: 0, type: "function", function: { name: "search_symbols", arguments: JSON.stringify({ query: "add", limit: 5 }) } }] };
            yield { type: "done" };
            return;
          }
          yield { type: "text", text: "add is in math.ts" };
          yield { type: "done" };
        },
      };

      await executeAgentChatTask({ db, taskId: "task-symbols", provider });

      expect(exposedTools).toContain("search_symbols");
      expect(exposedTools).not.toContain("run_command");
      const toolCall = convs.listToolCallsForMessage("msg-assistant")[0]!;
      expect(toolCall.toolName).toBe("search_symbols");
      const result = JSON.parse(toolCall.resultJson!);
      expect(result.symbols).toEqual([
        expect.objectContaining({ name: "add", kind: "function", filePath: "math.ts", startLine: 1 }),
      ]);
      expect(toolCall.resultJson).not.toContain("return a + b");
    });

    it("trims old conversation context before provider calls when the input budget is tight", async () => {
      const projects = projectRepository(db);
      const convs = conversationsRepository(db);
      const tasks = taskRepository(db);

      projects.createProject({
        id: "p1",
        name: "Trim Project",
        workspacePath: tempDir,
        createdAt: new Date().toISOString()
      });

      convs.createConversation({
        id: "c1",
        projectId: "p1",
        title: "Trim Chat",
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z"
      });

      convs.appendMessage({
        id: "msg-old-user",
        conversationId: "c1",
        role: "user",
        content: "ANCIENT_CONTEXT " + "alpha ".repeat(1200),
        createdAt: "2026-07-02T00:00:01.000Z",
        updatedAt: "2026-07-02T00:00:01.000Z"
      });
      convs.appendMessage({
        id: "msg-old-assistant",
        conversationId: "c1",
        role: "assistant",
        content: "OLD_ASSISTANT_CONTEXT " + "beta ".repeat(1200),
        createdAt: "2026-07-02T00:00:02.000Z",
        updatedAt: "2026-07-02T00:00:02.000Z"
      });
      convs.appendMessage({
        id: "msg-new-user",
        conversationId: "c1",
        role: "user",
        content: "LATEST_REQUEST keep this exact phrase",
        createdAt: "2026-07-02T00:00:03.000Z",
        updatedAt: "2026-07-02T00:00:03.000Z"
      });

      tasks.createTask({
        id: "task-1",
        projectId: "p1",
        kind: "agent_chat",
        status: "queued",
        createdAt: "2026-07-02T00:00:04.000Z"
      });

      convs.appendMessage({
        id: "msg-assistant",
        conversationId: "c1",
        role: "assistant",
        content: "",
        taskId: "task-1",
        streamingState: "queued",
        createdAt: "2026-07-02T00:00:04.000Z",
        updatedAt: "2026-07-02T00:00:04.000Z"
      });

      const captured: ChatMessage[][] = [];
      const provider: AiProvider = {
        id: "mock",
        async *streamChat(messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
          captured.push(messages);
          yield { type: "text", text: "trimmed ok" };
          yield { type: "done" };
        }
      };

      // Budget is comfortably larger than the mandatory system prompt + latest
      // request (~600 tokens) but far smaller than either ~1800-token old
      // message, so both stale turns must be trimmed while the system prompt and
      // latest request survive.
      await executeAgentChatTask({
        db,
        taskId: "task-1",
        provider,
        maxContextBytes: 3600
      });

      const sent = captured[0]!.map((message) => message.content).join("\n");
      expect(sent).toContain("You are Morrow");
      expect(sent).toContain("LATEST_REQUEST keep this exact phrase");
      expect(sent).not.toContain("ANCIENT_CONTEXT");
      expect(sent).not.toContain("OLD_ASSISTANT_CONTEXT");

      const trimEvent = taskRecordsRepository(db).listEvents("task-1").find((event) => event.type === "context.trimmed");
      expect(trimEvent?.payload).toMatchObject({ trimmedMessages: 2, maxInputTokens: 900 });
    });

    it("compacts old history into a persisted summary before falling back to raw history trimming", async () => {
      const projects = projectRepository(db);
      const convs = conversationsRepository(db);
      const tasks = taskRepository(db);

      projects.createProject({
        id: "p1",
        name: "Compact Project",
        workspacePath: tempDir,
        createdAt: new Date().toISOString()
      });
      convs.createConversation({
        id: "c1",
        projectId: "p1",
        title: "Compact Chat",
        createdAt: "2026-07-02T01:00:00.000Z",
        updatedAt: "2026-07-02T01:00:00.000Z"
      });
      convs.appendMessage({
        id: "msg-old-user",
        conversationId: "c1",
        role: "user",
        content: "Old goal: update src/app.ts. Command: pnpm test. API_KEY=abc123. " + "alpha ".repeat(500),
        createdAt: "2026-07-02T01:00:01.000Z",
        updatedAt: "2026-07-02T01:00:01.000Z"
      });
      convs.appendMessage({
        id: "msg-old-assistant",
        conversationId: "c1",
        role: "assistant",
        content: "Decision: preserve local-first routing. Error: test failed in src/app.ts. " + "beta ".repeat(500),
        createdAt: "2026-07-02T01:00:02.000Z",
        updatedAt: "2026-07-02T01:00:02.000Z"
      });
      convs.appendMessage({
        id: "msg-new-user",
        conversationId: "c1",
        role: "user",
        content: "Current request remains raw.",
        createdAt: "2026-07-02T01:00:03.000Z",
        updatedAt: "2026-07-02T01:00:03.000Z"
      });
      tasks.createTask({
        id: "task-1",
        projectId: "p1",
        kind: "agent_chat",
        status: "queued",
        createdAt: "2026-07-02T01:00:04.000Z"
      });
      convs.appendMessage({
        id: "msg-assistant",
        conversationId: "c1",
        role: "assistant",
        content: "",
        taskId: "task-1",
        streamingState: "queued",
        createdAt: "2026-07-02T01:00:04.000Z",
        updatedAt: "2026-07-02T01:00:04.000Z"
      });

      const captured: ChatMessage[][] = [];
      const provider: AiProvider = {
        id: "mock",
        async *streamChat(messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
          captured.push(messages);
          yield { type: "text", text: "compacted ok" };
          yield { type: "done" };
        }
      };

      await executeAgentChatTask({ db, taskId: "task-1", provider, maxContextBytes: 3600 });

      const sent = captured[0]!.map((message) => message.content).join("\n");
      expect(sent).toContain("Context summary (deterministic");
      expect(sent).toContain("src/app.ts");
      expect(sent).toContain("pnpm test");
      expect(sent).toContain("Current request remains raw.");
      expect(sent).not.toContain("abc123");
      expect(sent).not.toContain("alpha alpha alpha");

      const summary = db.prepare("SELECT * FROM context_summaries WHERE conversation_id = ?").get("c1") as { content: string; method: string; source_message_count: number } | undefined;
      expect(summary).toMatchObject({ method: "deterministic", source_message_count: 2 });
      expect(summary?.content).not.toContain("abc123");

      const events = taskRecordsRepository(db).listEvents("task-1").filter((event) => event.type.startsWith("context."));
      expect(events.map((event) => event.type)).toContain("context.compaction_completed");
      expect(JSON.stringify(events)).not.toContain("API_KEY");
      expect(JSON.stringify(events)).not.toContain("abc123");
    });

    it("fails before provider calls when minimum viable context cannot fit", async () => {
      const projects = projectRepository(db);
      const convs = conversationsRepository(db);
      const tasks = taskRepository(db);

      projects.createProject({
        id: "p1",
        name: "Tiny Context Project",
        workspacePath: tempDir,
        createdAt: new Date().toISOString()
      });
      convs.createConversation({
        id: "c1",
        projectId: "p1",
        title: "Tiny Chat",
        createdAt: "2026-07-02T02:00:00.000Z",
        updatedAt: "2026-07-02T02:00:00.000Z"
      });
      convs.appendMessage({
        id: "msg-user",
        conversationId: "c1",
        role: "user",
        content: "Current request must remain raw.",
        createdAt: "2026-07-02T02:00:01.000Z",
        updatedAt: "2026-07-02T02:00:01.000Z"
      });
      tasks.createTask({
        id: "task-1",
        projectId: "p1",
        kind: "agent_chat",
        status: "queued",
        createdAt: "2026-07-02T02:00:02.000Z"
      });
      convs.appendMessage({
        id: "msg-assistant",
        conversationId: "c1",
        role: "assistant",
        content: "",
        taskId: "task-1",
        streamingState: "queued",
        createdAt: "2026-07-02T02:00:02.000Z",
        updatedAt: "2026-07-02T02:00:02.000Z"
      });

      let providerCalls = 0;
      const provider: AiProvider = {
        id: "mock",
        async *streamChat(_messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
          providerCalls++;
          yield { type: "text", text: "should not run" };
        }
      };

      await executeAgentChatTask({ db, taskId: "task-1", provider, maxContextBytes: 20 });

      expect(providerCalls).toBe(0);
      expect(tasks.getTaskById("task-1")?.status).toBe("failed");
      const msg = convs.getMessage("msg-assistant");
      expect(msg?.streamingState).toBe("failed");
      expect(msg?.content).toContain("Recovery options");
      const event = taskRecordsRepository(db).listEvents("task-1").find((item) => item.type === "context.minimum_viable_context_exceeded");
      expect(event?.payload).toMatchObject({ provider: "mock", model: "mock-model" });
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
