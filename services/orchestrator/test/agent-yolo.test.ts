import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { ApprovalContinuationRegistry } from "../src/execution/continuation.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Seed an agent-mode task whose routing decision carries autoApprove (YOLO). */
function seedYolo(db: any, workspacePath: string, autoApprove: boolean) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "go", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

describe("agent trusted workspace", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "morrow-yolo-")); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("runs an ordinary command directly without manufacturing an approval record", async () => {
    seedYolo(db, ws, true);
    const provider = new MockProvider({ chunks: [[tool("x1", "run_command", { executable: "node", args: ["-e", "0"], purpose: "verify" }), done], [text("done"), done]], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(approvalsRepository(db).listByTask("t")).toHaveLength(0);
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "approval.requested")).toBe(false);
    expect(events.some((e: any) => e.type === "approval.resolved")).toBe(false);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("does not auto-resolve a material external-effect approval", async () => {
    seedYolo(db, ws, true);
    const provider = new MockProvider({ chunks: [[tool("x1", "run_command", { executable: "gh", args: ["release", "create", "v1.0.0"], purpose: "publish release" }), done]], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");

    let approval = approvalsRepository(db).listByTask("t")[0];
    for (let attempt = 0; !approval && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      approval = approvalsRepository(db).listByTask("t")[0];
    }
    expect(approval).toMatchObject({ status: "pending", details: { risk: "approval_required" } });
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) => event.type === "approval.requested")).toBe(true);
    approvalsRepository(db).resolve(approval!.id, { decision: "deny", resolvedAt: new Date().toISOString() });
    ApprovalContinuationRegistry.resolveApproval(approval!.id, "deny");
    await runner.waitFor("t");
  });

  it("still cannot run a categorically denied command — YOLO never bypasses deny", async () => {
    seedYolo(db, ws, true);
    // `rm` is a denied delete command; classification throws before any approval.
    const provider = new MockProvider({ chunks: [[tool("x1", "run_command", { executable: "rm", args: ["-rf", "."], purpose: "nope" }), done], [text("ok"), done]], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    // No approval is ever created for a denied command (so nothing to auto-approve).
    expect(approvalsRepository(db).listByTask("t")).toHaveLength(0);
    const runCall = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "run_command");
    expect(runCall?.status).toBe("failed");
    expect(JSON.parse(runCall!.resultJson!).error).toMatch(/denied/i);
  });

  it.each([
    ["force push", "git", ["push", "--force", "origin", "main"]],
    ["privilege escalation", "sudo", ["node", "script.mjs"]],
    ["workspace-redirect escape", "git", ["-C", "/etc", "status"]],
  ])("YOLO never bypasses the %s hard-block", async (_label, exec, cmdArgs) => {
    seedYolo(db, ws, true);
    const provider = new MockProvider({ chunks: [[tool("x1", "run_command", { executable: exec, args: cmdArgs, purpose: "nope" }), done], [text("ok"), done]], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(approvalsRepository(db).listByTask("t")).toHaveLength(0);
    const runCall = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "run_command");
    expect(runCall?.status).toBe("failed");
    expect(JSON.parse(runCall!.resultJson!).error).toMatch(/denied/i);
  });
});
