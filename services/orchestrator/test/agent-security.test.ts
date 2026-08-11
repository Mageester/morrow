import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { changeSetsRepository } from "../src/repositories/change-sets.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { memoryRepository } from "../src/repositories/memory.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { AgentMode } from "@morrow/contracts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function seed(db: any, workspacePath: string, mode: AgentMode, prompt = "go", agentId?: string, useMemory = false, autoApprove = false) {
  const project = projectRepository(db).getProjectById("p") ?? projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  const conv = conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const task = taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", ...(agentId ? { agentId } : {}), createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode, autoApprove },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
  return { project, conv, task };
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

describe("agent security boundaries", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "morrow-sec-")); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("agent mode discloses approval-gated writes and shell execution", async () => {
    seed(db, ws, "agent");
    const provider = new MockProvider({ chunks: [[text("done"), done]], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");
    const disc = taskRecordsRepository(db).getAggregate("t").disclosure!;
    expect(disc.filesystemAccess).toBe("workspace-write");
    expect(disc.shellExecution).toBe(true);
  });

  it("enforces the assigned agent tool and memory policy before exposure and side effects", async () => {
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: ws, createdAt: new Date().toISOString() });
    const agent = agentsRepository(db).create({
      id: "policy-agent", projectId: "p", name: "Policy agent", role: "researcher",
      memoryReadScopes: ["agent"], memoryWriteScopes: ["agent"],
    });
    agentsRepository(db).upsertToolPermission(agent.id, { toolName: "create_file", effect: "deny", priority: 10 });
    seed(db, ws, "agent", "PROTECTED_PROJECT_MEMORY", agent.id, true);
    memoryRepository(db).create({
      id: "project-memory", projectId: "p", scope: "project", content: "PROTECTED_PROJECT_MEMORY",
      source: "user", createdAt: new Date().toISOString(),
    });

    const provider = new MockProvider({
      chunks: [
        [tool("blocked-write", "create_file", { path: "blocked.txt", content: "must not be written" }), done],
        [text("The policy prevented the write."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(existsSync(join(ws, "blocked.txt"))).toBe(false);
    const call = conversationsRepository(db).listToolCallsForTask("t").find((item: any) => item.toolName === "create_file");
    expect(call?.status).toBe("failed");
    expect(JSON.parse(call!.resultJson!).error).toMatch(/agent policy|not permitted/i);
    expect(provider.requests[0]?.some((message) => message.content.includes("PROTECTED_PROJECT_MEMORY"))).toBe(false);
  });

  it("enforces the assigned agent provider-call budget across tool turns", async () => {
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: ws, createdAt: new Date().toISOString() });
    const agent = agentsRepository(db).create({
      id: "budget-agent", projectId: "p", name: "Budget agent", role: "researcher",
      maxProviderCalls: 1,
    });
    seed(db, ws, "agent", "Use one provider call only", agent.id);

    const provider = new MockProvider({
      chunks: [
        [tool("read-once", "read_file", { path: "evidence.txt" }), done],
        [text("This second provider response must never be requested."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(provider.requests).toHaveLength(1);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    const budgetEvent = taskRecordsRepository(db).listEvents("t").find(
      (event) => event.type === "task.progress_warning" && event.payload.signal === "explicit_budget_exhausted",
    );
    expect(budgetEvent?.payload.budget).toBe("provider_calls");
  });

  it("inspect (read-only) mode discloses read-only and refuses execution tools", async () => {
    seed(db, ws, "read-only");
    // The model attempts run_command, which inspect mode never exposes.
    const provider = new MockProvider({ chunks: [[tool("x1", "run_command", { executable: "node", args: ["-e", "1"], purpose: "x" }), done], [text("ok"), done]], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");
    const disc = taskRecordsRepository(db).getAggregate("t").disclosure!;
    expect(disc.filesystemAccess).toBe("read-only");
    expect(disc.shellExecution).toBe(false);
    const runCall = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "run_command");
    expect(runCall?.status).toBe("failed");
    expect(JSON.parse(runCall!.resultJson!).error).toMatch(/not permitted/i);
    // A tool call denied purely because read-only mode forbids it is an
    // expected constraint, not a failed verification: the task still
    // produced a correct final answer and made no changes, so it must be
    // reported as completed, not interrupted (consumer usability baseline).
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("preserves a denied inspection action while recording incomplete evidence", async () => {
    seed(db, ws, "read-only", "Inspect the workspace and report what you find.");
    const provider = new MockProvider({ chunks: [[tool("x1", "run_command", { executable: "node", args: ["-e", "1"], purpose: "inspect" }), done], [text("The inspection is complete."), done]], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const evidence = executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson as { completion?: { complete?: boolean; blockers?: Array<{ code?: string }> } } | undefined;
    expect(evidence?.completion?.complete).toBe(false);
    expect(evidence?.completion?.blockers?.some((blocker) => blocker.code === "missing_read_only_observation")).toBe(true);
  });

  // Regression: a model can violate run_command's declared `args: string[]`
  // schema (e.g. send a single space-joined string instead of an array).
  // `args.args || []` only guards falsy values, so a truthy non-array slipped
  // straight into command-policy's `args.map(...)` and crashed the task with
  // an opaque host-side "args.map is not a function" TypeError instead of a
  // normal, retryable tool-call error.
  it("rejects a non-array run_command args with a clear error instead of crashing", async () => {
    seed(db, ws, "agent");
    const provider = new MockProvider({
      chunks: [[tool("x1", "run_command", { executable: "node", args: "--check script.js", purpose: "x" }), done], [text("ok"), done]],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");
    const runCall = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "run_command");
    expect(runCall?.status).toBe("failed");
    expect(JSON.parse(runCall!.resultJson!).error).toMatch(/args.*must be an array/i);
    // The task itself must not be left crashed/stuck by the host-side
    // TypeError this used to throw — it must reach a real terminal status.
    // A recoverable schema violation is returned to the model as a structured
    // observation; the model's later final answer remains authoritative.
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("does not resurrect a cancelled task when its approval is later resolved", async () => {
    const { project } = seed(db, ws, "agent");
    const provider = new MockProvider({ chunks: [[tool("x1", "run_command", { executable: "node", args: ["-e", "1"], purpose: "x" }), done], [text("should not run"), done]], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4, ...(d.abortSignal ? { abortSignal: d.abortSignal } : {}) }));
    const app = buildServer({ db, runner, sseIntervalMs: 5 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      runner.run("t");
      // Wait for the command approval.
      const start = Date.now();
      let approvalId = "";
      while (Date.now() - start < 8000) {
        const pend = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/approvals?status=pending` })).json();
        if (pend.length) { approvalId = pend[0].id; break; }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(approvalId).not.toBe("");
      // Cancel the task, then resolve the approval.
      await app.inject({ method: "POST", url: `/api/tasks/t/cancel` });
      await app.inject({ method: "POST", url: `/api/approvals/${approvalId}/resolve`, payload: { projectId: project.id, decision: "allow_once" } });
      await new Promise((r) => setTimeout(r, 200));
      // The cancelled task must NOT be revived.
      expect(taskRepository(db).getTaskById("t")!.status).toBe("cancelled");
    } finally {
      await app.close();
    }
  }, 15000);

  it("/diff selects the most recent applied change set", async () => {
    seed(db, ws, "agent");
    const cs = changeSetsRepository(db);
    cs.create({ id: "cs-old", taskId: "t", projectId: "p", approvalId: null, diff: "OLD-DIFF", diffHash: "h1", originalHashes: { "a.ts": "x" } }, "2026-06-21T00:00:00.000Z");
    cs.updateApplied("cs-old", { "a.ts": "y" }, { "a.ts": "x" }, "2026-06-21T00:00:01.000Z");
    cs.create({ id: "cs-new", taskId: "t", projectId: "p", approvalId: null, diff: "NEW-DIFF", diffHash: "h2", originalHashes: { "b.ts": "x" } }, "2026-06-21T00:00:02.000Z");
    cs.updateApplied("cs-new", { "b.ts": "y" }, { "b.ts": "x" }, "2026-06-21T00:00:03.000Z");
    const app = buildServer({ db, runner: new TaskRunner(db, async () => {}), sseIntervalMs: 5 });
    await app.ready();
    try {
      const diff = (await app.inject({ method: "GET", url: `/api/tasks/t/diff` })).json();
      expect(diff.diff).toBe("NEW-DIFF");
      expect(diff.id).toBe("cs-new");
    } finally {
      await app.close();
    }
  });
});
