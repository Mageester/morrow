import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { ProviderError, type AiProvider, type ProviderChunk } from "../src/provider/base.js";

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
    expect(fb!.payload).toMatchObject({ servedBy: "secondary", freshSegment: true, segmentSequence: 2 });
    expect(fb!.payload.routeFingerprint).toEqual(expect.any(String));
    expect(executionContinuityRepository(db).listSegments("t1").map((segment) => ({ providerId: segment.providerId, status: segment.status }))).toEqual([
      { providerId: "mock", status: "checkpointed" },
      { providerId: "secondary", status: "completed" },
    ]);
  });

  it("records every provider start attempt, including a failed fallback candidate", async () => {
    const secondary = new MockProvider({ chunks: [[{ type: "text", text: "answer via fallback" }, { type: "done" }]] });
    (secondary as unknown as { id: string }).id = "secondary";

    await executeAgentChatTask({
      db,
      taskId: "t1",
      provider: throwingProvider("ECONNREFUSED"),
      fallbackProviders: [secondary],
    });

    const events = taskRecordsRepository(db).listEvents("t1") as Array<{ type: string; payload: any }>;
    const attempts = events.filter((event) => event.type === "provider.request_started");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((event) => event.payload.provider)).toEqual(["mock", "secondary"]);
  });

  it("treats a provider console upstream failure as transient and recovers", async () => {
    const secondary = new MockProvider({ chunks: [[{ type: "text", text: "recovered after upstream failure" }, { type: "done" }]] });
    (secondary as unknown as { id: string }).id = "secondary";

    await executeAgentChatTask({
      db,
      taskId: "t1",
      provider: throwingProvider("Error from provider (Console): Upstream request failed"),
      fallbackProviders: [secondary],
    });

    expect(taskRepository(db).getTaskById("t1")?.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")?.content).toBe("recovered after upstream failure");
  });

  it("recovers when a compatible gateway mislabels an upstream outage as non-retryable", async () => {
    const primary: AiProvider = {
      async *streamChat(): AsyncIterable<ProviderChunk> {
        throw new ProviderError("provider_error", "Error from provider (Console): Upstream request failed", {
          kind: "provider",
          retryable: false,
        });
      },
    };
    const secondary = new MockProvider({ chunks: [[{ type: "text", text: "recovered from mislabeled outage" }, { type: "done" }]] });
    (secondary as unknown as { id: string }).id = "secondary";

    await executeAgentChatTask({ db, taskId: "t1", provider: primary, fallbackProviders: [secondary] });

    expect(taskRepository(db).getTaskById("t1")?.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")?.content).toBe("recovered from mislabeled outage");
  });

  it("recovers when a gateway wraps an upstream outage in HTTP 400", async () => {
    const primary: AiProvider = {
      async *streamChat(): AsyncIterable<ProviderChunk> {
        throw new ProviderError("invalid_request", "Error from provider (Console): Upstream request failed", {
          kind: "invalid_request",
          retryable: false,
          status: 400,
        });
      },
    };
    const secondary = new MockProvider({ chunks: [[{ type: "text", text: "recovered from wrapped upstream outage" }, { type: "done" }]] });
    (secondary as unknown as { id: string }).id = "secondary";

    await executeAgentChatTask({ db, taskId: "t1", provider: primary, fallbackProviders: [secondary] });

    expect(taskRepository(db).getTaskById("t1")?.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")?.content).toBe("recovered from wrapped upstream outage");
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

  it("logs only a sanitized provider classification and persists a bounded redacted failure", async () => {
    const probe = "credential sk-abcdefghijklmnop";
    const error = new ProviderError("invalid_request", `provider response body: ${probe}`, {
      kind: "invalid_request",
      retryable: false,
      status: 400,
    });
    const primary: AiProvider = {
      async *streamChat(): AsyncIterable<ProviderChunk> {
        throw error;
      },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await executeAgentChatTask({ db, taskId: "t1", provider: primary });

      expect(consoleError.mock.calls.flat().map(String).join(" ")).not.toContain(probe);
      const durable = JSON.stringify({
        task: taskRepository(db).getTaskById("t1"),
        message: conversationsRepository(db).getMessage("ma"),
        events: taskRecordsRepository(db).listEvents("t1"),
        segments: executionContinuityRepository(db).listSegments("t1"),
      });
      expect(durable).not.toContain(probe);
      expect(durable).toContain("***redacted***");
    } finally {
      consoleError.mockRestore();
    }
  });
});
