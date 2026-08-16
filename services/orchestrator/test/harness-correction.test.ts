import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { createLoopDetector, isRepeatAdvisoryPoint, toolCallSignature } from "../src/execution/loop-detector.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";

function seedYolo(db: any, workspacePath: string, prompt = "Build the requested app") {
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "Pulse", workspacePath, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "Pulse", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "u", conversationId: "c", role: "user", content: prompt, createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "harness correction", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });
}

const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const done = { type: "done" as const };

describe("harness correction", () => {
  let db: any;
  let workspace = "";

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "morrow-harness-correction-")));
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    rmSync(workspace, { recursive: true, force: true });
  });

  it("counts canonical exact calls for advisory scheduling without a loop decision", () => {
    const detector = createLoopDetector();
    const first = toolCallSignature("create_file", { path: "package.json", content: "same" });
    const equivalent = toolCallSignature("create_file", { content: "same", path: "package.json" });

    expect(first).toBe(equivalent);
    expect(detector.record(first)).toMatchObject({ count: 1, looping: false });
    expect(detector.record(equivalent)).toMatchObject({ count: 2, looping: false });
    const third = detector.record(first);
    expect(third).toMatchObject({ count: 3, looping: false });
    expect(isRepeatAdvisoryPoint(third.count)).toBe(true);
  });

  it("overwrites an existing create_file target directly with undo metadata, without target_exists strategy switching", async () => {
    seedYolo(db, workspace);
    const target = join(workspace, "server.js");
    writeFileSync(target, "old\n", "utf8");
    const provider = new MockProvider({
      chunks: [
        [tool("write", "create_file", { path: "server.js", content: "new\n" }), done],
        [{ type: "text", text: "The file was replaced." }, done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

    expect(readFileSync(target, "utf8")).toBe("new\n");
    const call = conversationsRepository(db).listToolCallsForTask("t").find((row) => row.id === "write");
    expect(call?.status).toBe("completed");
    expect(JSON.parse(call!.resultJson!)).toMatchObject({ strategy: "overwrite", changed: true });
    expect(taskRecordsRepository(db).listEvents("t").some((event) => event.type === "tool.strategy_switch" && event.payload.reason === "target_exists")).toBe(false);
  });

  it("treats a tool-only provider turn as valid and asks for the next turn without an empty-response retry", async () => {
    seedYolo(db, workspace);
    const provider = new MockProvider({
      chunks: [
        [tool("write", "create_file", { path: "ready.txt", content: "ready\n" }), done],
        [{ type: "text", text: "The requested file is ready." }, done],
      ],
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

    expect(provider.requests).toHaveLength(2);
    expect(taskRecordsRepository(db).listEvents("t").some((event) => event.payload.reason === "empty_provider_response")).toBe(false);
    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
  });

  it("bounds empty provider retries and leaves an explicit incomplete terminal record", async () => {
    seedYolo(db, workspace, "Return a final answer only after the provider emits one.");
    const provider = new MockProvider({ chunks: [[], [], [], [], [{ type: "text", text: "late answer" }, done]] });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 2 });

    const events = taskRecordsRepository(db).listEvents("t");
    expect(provider.requests).toHaveLength(4);
    expect(events.filter((event) => event.payload.reason === "empty_provider_response")).toHaveLength(3);
    expect(taskRepository(db).getTaskById("t")?.status).toBe("interrupted");
    expect(conversationsRepository(db).getMessage("a")?.content).toMatch(/incomplete/i);
  });

});
