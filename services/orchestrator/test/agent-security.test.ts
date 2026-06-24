import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { changeSetsRepository } from "../src/repositories/change-sets.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { AgentMode } from "@morrow/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function seed(db: any, workspacePath: string, mode: AgentMode) {
  const project = projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  const conv = conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "go", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const task = taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode },
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
