import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { ProviderChunk } from "../src/provider/base.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "../../../fixtures/agent-repair");

// The exact unified diff that repairs the seeded defect (subtract -> add).
const REPAIR_PATCH = [
  "--- a/src/math.mjs",
  "+++ b/src/math.mjs",
  "@@ -1,4 +1,4 @@",
  " export function add(a, b) {",
  "   // Defect: subtracts instead of adds; the repair changes minus to plus.",
  "-  return a - b;",
  "+  return a + b;",
  " }",
  "",
].join("\n");

function tool(id: string, index: number, name: string, args: unknown): ProviderChunk {
  return { type: "tool_call", toolCalls: [{ id, index, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
const done: ProviderChunk = { type: "done" };
const text = (t: string): ProviderChunk => ({ type: "text", text: t });

function copyFixture(dest: string): void {
  mkdirSync(join(dest, "src"), { recursive: true });
  mkdirSync(join(dest, "test"), { recursive: true });
  writeFileSync(join(dest, "package.json"), readFileSync(join(FIXTURE_DIR, "package.json"), "utf8"));
  writeFileSync(join(dest, "src", "math.mjs"), readFileSync(join(FIXTURE_DIR, "src", "math.mjs"), "utf8"));
  writeFileSync(join(dest, "test", "run.mjs"), readFileSync(join(FIXTURE_DIR, "test", "run.mjs"), "utf8"));
}

function seed(db: any, workspacePath: string, opts: { mode: string; autoApprove: boolean }) {
  const projects = projectRepository(db);
  const convs = conversationsRepository(db);
  const tasks = taskRepository(db);
  const routingRepo = taskRoutingRepository(db);
  const records = taskRecordsRepository(db);
  const project = projects.createProject({ id: "p1", name: "Gate Project", workspacePath, createdAt: new Date().toISOString() });
  const conversation = convs.createConversation({ id: "c1", projectId: project.id, title: "Gate", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  convs.appendMessage({ id: "m-user", conversationId: conversation.id, role: "user", content: "Use a skill to look for bugs in the current workspace.", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const task = tasks.createTask({ id: "t1", projectId: project.id, kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  convs.appendMessage({ id: "m-assistant", conversationId: conversation.id, role: "assistant", content: "", taskId: task.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  routingRepo.upsert({
    taskId: task.id, presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: opts.mode as any, autoApprove: opts.autoApprove },
    createdAt: new Date().toISOString(),
  });
  records.transitionAgentState(task.id, { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
  return { project, task };
}

function runnerFor(db: any, provider: MockProvider): TaskRunner {
  return new TaskRunner(db, async (deps) => {
    await executeAgentChatTask({ db: deps.db, taskId: deps.taskId, provider, maxTurns: 12, ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}) });
  });
}

const mathSrc = (ws: string) => readFileSync(join(ws, "src", "math.mjs"), "utf8");
const nudges = (db: any, taskId: string) => taskRecordsRepository(db).listEvents(taskId).filter((e: any) => e.type === "agent.execution_nudge");

describe("Agent-mode execution gate", () => {
  let ws: string, home: string, env: NodeJS.ProcessEnv, db: any;
  beforeEach(() => {
    env = { ...process.env };
    home = mkdtempSync(join(tmpdir(), "morrow-gate-home-"));
    process.env.MORROW_HOME = home;
    ws = mkdtempSync(join(tmpdir(), "morrow-gate-ws-"));
    copyFixture(ws);
  });
  afterEach(() => {
    process.env = env;
    if (db) { try { db.close(); } catch { /* ignore */ } db = undefined; }
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("converts a defer-to-ask into an executed, verified fix (automatic approvals)", async () => {
    db = openDatabase(":memory:");
    const { project, task } = seed(db, ws, { mode: "agent", autoApprove: true });
    const provider = new MockProvider({
      delayMs: 2,
      chunks: [
        [text("Reading the implicated source."), tool("t1", 0, "read_file", { path: "src/math.mjs" }), done],
        // The exact real-world failure: finds the bug, then ASKS instead of fixing.
        [text("I found the defect in src/math.mjs: it subtracts instead of adds. Would you like me to fix it?"), done],
        // After the gate's nudge, it executes.
        [tool("t2", 0, "propose_patch", { patch: REPAIR_PATCH, explanation: "add not subtract", files: ["src/math.mjs"] }), done],
        [text("Patch applied. Verifying."), tool("t3", 0, "run_command", { executable: "node", args: ["test/run.mjs"], purpose: "verify the fix" }), done],
        [text("Fixed: changed `-` to `+` in src/math.mjs; the test now passes."), done],
      ],
    });
    const runner = runnerFor(db, provider);
    runner.run(task.id);
    await runner.waitFor(task.id);

    expect(taskRepository(db).getTaskById(task.id)!.status).toBe("completed");
    expect(mathSrc(ws)).toContain("return a + b;"); // the fix was actually applied
    const calls = conversationsRepository(db).listToolCallsForTask(task.id);
    expect(calls.some((c: any) => c.toolName === "propose_patch" && c.status === "completed")).toBe(true);
    const runCall = calls.find((c: any) => c.toolName === "run_command");
    expect(JSON.parse(runCall!.resultJson!).exitCode).toBe(0); // verification passed
    expect(nudges(db, task.id).length).toBe(1); // the gate fired exactly once
    expect(approvalsRepository(db).listByProject(project.id, "pending").length).toBe(0); // never asked a human
  }, 30000);

  it("does not nudge in Ask (read-only) mode — it answers and recommends only", async () => {
    db = openDatabase(":memory:");
    const { task } = seed(db, ws, { mode: "read-only", autoApprove: false });
    const provider = new MockProvider({
      delayMs: 2,
      chunks: [
        [text("Reading the source."), tool("t1", 0, "read_file", { path: "src/math.mjs" }), done],
        [text("I found a bug: src/math.mjs subtracts instead of adds. You could change `-` to `+`. Would you like me to fix it?"), done],
      ],
    });
    const runner = runnerFor(db, provider);
    runner.run(task.id);
    await runner.waitFor(task.id);

    expect(taskRepository(db).getTaskById(task.id)!.status).toBe("completed");
    expect(mathSrc(ws)).toContain("return a - b;"); // unchanged — analysis only
    expect(nudges(db, task.id).length).toBe(0); // gate is agent-mode only
    expect(conversationsRepository(db).listToolCallsForTask(task.id).some((c: any) => c.toolName === "propose_patch")).toBe(false);
  }, 30000);

  it("respects a genuine blocker and does not nudge past it", async () => {
    db = openDatabase(":memory:");
    const { task } = seed(db, ws, { mode: "agent", autoApprove: true });
    const provider = new MockProvider({
      delayMs: 2,
      chunks: [
        [text("Reading the source."), tool("t1", 0, "read_file", { path: "src/math.mjs" }), done],
        // Contains a defer phrase AND a real blocker — must NOT be nudged.
        [text("I can fix this, but I cannot proceed without the missing credentials."), done],
      ],
    });
    const runner = runnerFor(db, provider);
    runner.run(task.id);
    await runner.waitFor(task.id);

    expect(taskRepository(db).getTaskById(task.id)!.status).toBe("completed");
    expect(mathSrc(ws)).toContain("return a - b;"); // unchanged — blocked
    expect(nudges(db, task.id).length).toBe(0);
  }, 30000);

  it("nudges at most twice, then stops (no infinite loop on a stubborn model)", async () => {
    db = openDatabase(":memory:");
    const { task } = seed(db, ws, { mode: "agent", autoApprove: true });
    const provider = new MockProvider({
      delayMs: 2,
      chunks: [
        [text("I can fix the subtract/add defect if you want. Should I proceed?"), done],
        [text("I can apply the fix. Would you like me to continue?"), done],
        [text("I can make the change. Want me to proceed?"), done],
        [text("I can implement it. Shall I proceed?"), done],
      ],
    });
    const runner = runnerFor(db, provider);
    runner.run(task.id);
    await runner.waitFor(task.id);

    // The gate fires its bounded number of times and then lets the run end,
    // rather than nudging forever.
    expect(nudges(db, task.id).length).toBe(2);
    expect(["completed", "interrupted"]).toContain(taskRepository(db).getTaskById(task.id)!.status);
  }, 30000);
});
