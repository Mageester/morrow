import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { createConvergenceGuard, canonicalOperationIdentity } from "../src/execution/convergence-guard.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
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

  it("canonicalizes operation identity separately from content", () => {
    expect(canonicalOperationIdentity("create_file", { path: ".\\src\\..\\package.json", content: "one" })).toEqual({
      toolFamily: "workspace-write",
      targetPath: "package.json",
      operationClass: "overwrite",
      key: "workspace-write|package.json|overwrite",
    });
    expect(canonicalOperationIdentity("create_file", { path: "package.json", content: "two" }).key)
      .toBe("workspace-write|package.json|overwrite");
  });

  it("stalls same-target changed-content churn without confusing it with legitimate verified edits", () => {
    const guard = createConvergenceGuard({ exactRepeatThreshold: 2, stallThreshold: 3 });
    const observe = (content: string, progress = {}) => guard.observeTurn({
      calls: [{ toolName: "create_file", args: { path: "package.json", content }, outcome: "success", changed: true }],
      progress,
    });

    expect(observe("one").stalled).toBe(false);
    expect(observe("two").churn?.uniqueArgumentCount).toBe(2);
    expect(observe("three").stalled).toBe(true);
    expect(observe("four").reason).toBe("same_target_write_churn");

    const verified = createConvergenceGuard({ stallThreshold: 2 });
    verified.observeTurn({
      calls: [{ toolName: "create_file", args: { path: "app.js", content: "v1" }, outcome: "success", changed: true }],
      progress: {},
    });
    verified.observeTurn({
      calls: [{ toolName: "create_file", args: { path: "app.js", content: "v2" }, outcome: "success", changed: true }],
      progress: { verificationPassed: true },
    });
    expect(verified.observeTurn({
      calls: [{ toolName: "create_file", args: { path: "app.js", content: "v3" }, outcome: "success", changed: true }],
      progress: {},
    }).stalled).toBe(false);
  });

  it("does not treat successful no-op writes as progress and persists a resumable state", () => {
    const guard = createConvergenceGuard({ stallThreshold: 2 });
    guard.observeTurn({
      calls: [{ toolName: "create_file", args: { path: "same.txt", content: "same" }, outcome: "success", changed: false }],
      progress: {},
    });
    const second = guard.observeTurn({
      calls: [{ toolName: "create_file", args: { path: "same.txt", content: "same" }, outcome: "success", changed: false }],
      progress: {},
    });
    expect(second.stalled).toBe(true);
    expect(second.advisory).toMatch(/same target/i);

    const restored = createConvergenceGuard({ stallThreshold: 2 });
    restored.restore(guard.snapshot());
    expect(restored.snapshot().nonProgressCycles).toBe(2);
    expect(restored.observeTurn({
      calls: [{ toolName: "create_file", args: { path: "same.txt", content: "same" }, outcome: "success", changed: false }],
      progress: {},
    }).stalled).toBe(true);
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

  it("stops a deterministic Pulse-style repeated-write provider with an explicit checkpoint instead of exhausting turns", async () => {
    seedYolo(db, workspace, "Build the complete Pulse service-health monitor and verify it.");
    const provider = new MockProvider({
      chunks: Array.from({ length: 10 }, (_, index) => [
        tool(`rewrite-${index}`, "create_file", { path: index % 2 ? "server.js" : "package.json", content: `rewrite ${index}\n` }),
        done,
      ]),
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

    const events = taskRecordsRepository(db).listEvents("t");
    expect(taskRepository(db).getTaskById("t")?.status).toBe("interrupted");
    expect(provider.requests.length).toBeLessThan(8);
    expect(events.some((event) => event.payload.reason === "loop_stalled")).toBe(true);
    expect(events.some((event) => event.payload.message && String(event.payload.message).includes("same target"))).toBe(true);
    expect(executionContinuityRepository(db).latestCheckpoint("t")?.snapshot.convergence?.nonProgressCycles).toBeGreaterThanOrEqual(3);
  });

  it("rehydrates the convergence advisory on resume without replaying a write", async () => {
    seedYolo(db, workspace, "Build the complete Pulse service-health monitor and verify it.");
    const pathological = new MockProvider({
      chunks: Array.from({ length: 8 }, (_, index) => [
        tool(`rewrite-${index}`, "create_file", { path: index % 2 ? "server.js" : "package.json", content: `rewrite ${index}\n` }),
        done,
      ]),
    });
    await executeAgentChatTask({ db, taskId: "t", provider: pathological, maxTurns: 4 });
    expect(taskRepository(db).getTaskById("t")?.status).toBe("interrupted");

    const resumed = new MockProvider({ chunks: [[{ type: "text", text: "Paused for a strategy change; awaiting new instructions." }, done]] });
    await executeAgentChatTask({ db, taskId: "t", provider: resumed, maxTurns: 2 });

    expect(resumed.requests[0]?.some((message) => message.role === "system" && message.content.includes("Morrow convergence advisory"))).toBe(true);
    expect(conversationsRepository(db).listToolCallsForTask("t").filter((call) => call.toolName === "create_file").length).toBeLessThanOrEqual(6);
  });
});
