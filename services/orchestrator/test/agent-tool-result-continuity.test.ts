import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { TaskRunner } from "../src/runner.js";
import { reconcileTasksOnStartup } from "../src/recovery.js";
import type { AiProvider, ChatMessage, ProviderChunk } from "../src/provider/base.js";

describe("durable tool-result continuity", () => {
  it("keeps the completed tool request and exact result on the immediately following request", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-tool-result-continuity-"));
    const db = openDatabase(":memory:");
    try {
      const now = new Date().toISOString();
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: now });
      const conversations = conversationsRepository(db);
      conversations.createConversation({ id: "c", projectId: "p", title: "C", createdAt: now, updatedAt: now });
      conversations.appendMessage({ id: "u", conversationId: "c", role: "user", content: "Create result.txt and finish.", createdAt: now, updatedAt: now });
      taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
      conversations.appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: now, updatedAt: now });
      taskRoutingRepository(db).upsert({
        taskId: "t",
        presetId: "best-quality",
        providerId: "mock",
        model: "mock-model",
        useMemory: false,
        decision: {
          version: 1,
          presetId: "best-quality",
          providerId: "mock",
          model: "mock-model",
          reason: "durable-result-continuity",
          fallbackUsed: false,
          overridden: true,
          privacy: "cloud",
          candidates: [],
          mode: "agent",
          toolProfile: "agent",
          autoApprove: true,
        },
        createdAt: now,
      });

      const requests: ChatMessage[][] = [];
      let providerCalls = 0;
      const provider: AiProvider = {
        id: "mock",
        async *streamChat(messages): AsyncIterable<ProviderChunk> {
          requests.push(structuredClone(messages));
          providerCalls += 1;
          if (providerCalls === 1) {
            yield {
              type: "tool_call",
              toolCalls: [{
                id: "write-once",
                index: 0,
                type: "function",
                function: { name: "create_file", arguments: JSON.stringify({ path: "result.txt", content: "written once\n" }) },
              }],
            };
          } else {
            yield { type: "text", text: "Finished with the durable result present." };
          }
          yield { type: "done" };
        },
      };

      await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

      expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
      expect(providerCalls).toBe(2);
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("written once\n");
      const nextRequest = requests[1]!;
      const assistantCalls = nextRequest.flatMap((message) => message.toolCalls ?? []);
      const toolResults = nextRequest.filter((message) => message.role === "tool" && message.toolCallId === "write-once");
      expect(assistantCalls.filter((call) => call.id === "write-once")).toHaveLength(1);
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]?.content).toContain('"created":true');
      expect(JSON.stringify(nextRequest)).not.toContain("_morrowAppliedWrite");
      expect(JSON.stringify(nextRequest)).not.toContain("Morrow durable write record.");
      expect(conversations.listToolCallsForTask("t").filter((call) => call.id === "write-once")).toHaveLength(1);
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reconstructs an oversized successful result from its durable artifact after a segment restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-large-tool-result-continuity-"));
    const dbPath = join(root, "morrow.sqlite");
    let db = openDatabase(dbPath);
    const taskId = "large-result-task";
    try {
      const now = new Date().toISOString();
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "large.txt"), "x".repeat(20_000));
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: now });
      const conversations = conversationsRepository(db);
      conversations.createConversation({ id: "c", projectId: "p", title: "C", createdAt: now, updatedAt: now });
      conversations.appendMessage({ id: "u", conversationId: "c", role: "user", content: "Capture the command output and finish after restart.", createdAt: now, updatedAt: now });
      taskRepository(db).createTask({ id: taskId, projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
      conversations.appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId, streamingState: "queued", createdAt: now, updatedAt: now });
      taskRoutingRepository(db).upsert({
        taskId,
        presetId: "best-quality",
        providerId: "mock",
        model: "mock-model",
        useMemory: false,
        decision: {
          version: 1,
          presetId: "best-quality",
          providerId: "mock",
          model: "mock-model",
          reason: "large-result-continuity",
          fallbackUsed: false,
          overridden: true,
          privacy: "cloud",
          candidates: [],
          mode: "agent",
          toolProfile: "agent",
          autoApprove: true,
        },
        createdAt: now,
      });

      const firstRequests: ChatMessage[][] = [];
      const firstProvider: AiProvider = {
        id: "mock",
        async *streamChat(messages): AsyncIterable<ProviderChunk> {
          firstRequests.push(structuredClone(messages));
          const callIndex = firstRequests.length - 1;
          yield {
            type: "tool_call",
            toolCalls: [{
              id: `large-output-${callIndex}`,
              index: 0,
              type: "function",
              function: callIndex === 22
                ? {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "large.txt" }),
                  }
                : {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "missing.txt" }),
                  },
            }],
          };
          yield { type: "done" };
        },
      };

      let stoppedAtBoundary = false;
      try {
        await executeAgentChatTask({
          db,
          taskId,
          provider: firstProvider,
          maxTurns: 1,
          onSegmentBoundary: (reason) => {
            if (reason === "turn_budget") {
              stoppedAtBoundary = true;
              throw new Error("SIMULATED_LARGE_RESULT_RESTART");
            }
          },
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "SIMULATED_LARGE_RESULT_RESTART") throw error;
      }

      expect(stoppedAtBoundary).toBe(true);
      expect(firstRequests.length).toBeGreaterThan(1);
      const storedCall = conversations.listToolCallsForTask(taskId).find((call) => {
        if (call.toolName !== "read_file") return false;
        try { return (JSON.parse(call.argsJson) as { path?: unknown }).path === "large.txt"; } catch { return false; }
      });
      expect(storedCall?.status).toBe("completed");
      expect((storedCall?.resultJson ?? "").length).toBeGreaterThan(8_000);

      const immediateRequest = firstRequests.find((request) => request.some((message) => message.role === "tool" && message.toolCallId === storedCall!.id));
      expect(immediateRequest).toBeDefined();
      const immediateResults = immediateRequest!.filter((message) => message.role === "tool" && message.toolCallId === storedCall!.id);
      expect(immediateResults).toHaveLength(1);
      expect(immediateResults[0]?.content).toContain("artifactId");
      expect(immediateResults[0]?.content).toContain("read_artifact");
      expect((immediateResults[0]?.content.length ?? 0)).toBeLessThan(2_000);
      expect(immediateResults[0]?.content).not.toContain("x".repeat(8_000));

      db.prepare("UPDATE agent_execution_segments SET owner_id=? WHERE task_id=? AND status='running'")
        .run("morrow-pid:999999999:large-result", taskId);
      db.close();
      db = openDatabase(dbPath);

      const restartRequests: ChatMessage[][] = [];
      const restartProvider: AiProvider = {
        id: "mock",
        async *streamChat(messages): AsyncIterable<ProviderChunk> {
          restartRequests.push(structuredClone(messages));
          yield { type: "text", text: "Finished after restart with the durable output." };
          yield { type: "done" };
        },
      };
      const runner = new TaskRunner(db, async (deps) => executeAgentChatTask({
        db: deps.db,
        taskId: deps.taskId,
        provider: restartProvider,
        ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}),
        ...(deps.recovery ? { recovery: deps.recovery } : {}),
      }));

      expect(reconcileTasksOnStartup({ db, runner }).requeued).toBe(1);
      await runner.waitFor(taskId);

      expect(taskRepository(db).getTaskById(taskId)?.status).toBe("completed");
      expect(restartRequests).toHaveLength(1);
      const restarted = restartRequests[0]!;
      const calls = restarted.flatMap((message) => message.toolCalls ?? []).filter((call) => call.id === storedCall!.id);
      const results = restarted.filter((message) => message.role === "tool" && message.toolCallId === storedCall!.id);
      expect(calls).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe(immediateResults[0]?.content);
      expect(results[0]?.content).toContain("artifactId");
      expect(results[0]?.content).toContain("read_artifact");
      expect((results[0]?.content.length ?? 0)).toBeLessThan(2_000);
      expect(results[0]?.content).not.toContain("x".repeat(8_000));
      expect(JSON.stringify(restarted)).not.toContain("_morrowAppliedWrite");
      expect(executionContinuityRepository(db).listSegments(taskId).length).toBeGreaterThanOrEqual(2);
    } finally {
      try { db.close(); } catch { /* already closed */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
