import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { ReadBudget, ReadBudgetExceeded } from "../src/execution/read-budget.js";
import { createRepeatedFailureTracker, errorIdentity, repeatedFailureAdvice } from "../src/execution/loop-detector.js";

describe("ReadBudget", () => {
  it("does not charge a read it refuses", () => {
    const budget = new ReadBudget(1000);
    budget.charge(900, "First read");
    expect(() => budget.charge(200, "Second read")).toThrow(ReadBudgetExceeded);
    // The refused 200 bytes must not be counted: a later small read still fits.
    expect(budget.consumedBytes).toBe(900);
    expect(() => budget.charge(100, "Third read")).not.toThrow();
  });

  it("explains that the ceiling is cumulative, not a complaint about this request", () => {
    const budget = new ReadBudget(512 * 1024);
    budget.charge(512 * 1024, "A large sweep");
    // The DropSort case: a 5,350-byte file refused by a 512 KB task ceiling.
    let message = "";
    try { budget.charge(5_350, "Reading dropsort/cli.py"); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("already pulled");
    expect(message).toContain("Do not repeat it");
    expect(message).toMatch(/search_text|offset/);
  });

  it("releases the budget when context is compacted", () => {
    const budget = new ReadBudget(1000);
    budget.charge(1000, "A large sweep");
    expect(() => budget.charge(10, "A tiny read")).toThrow();
    budget.releaseForCompaction();
    expect(budget.consumedBytes).toBe(0);
    expect(() => budget.charge(10, "A tiny read")).not.toThrow();
  });
});

describe("repeated identical failures", () => {
  it("counts only the same call failing the same way", () => {
    const tracker = createRepeatedFailureTracker();
    const identity = errorIdentity("safe_read_rejected", "Read budget exhausted: 512 KB ceiling");
    expect(tracker.record("read_artifact:{}", identity)).toBe(1);
    expect(tracker.record("read_artifact:{}", identity)).toBe(2);
    expect(tracker.record("read_file:{}", identity)).toBe(1);
  });

  it("treats messages differing only in volatile magnitudes as the same wall", () => {
    expect(errorIdentity("safe_read_rejected", "needs 12 KB, 0 KB remains"))
      .toBe(errorIdentity("safe_read_rejected", "needs 34 KB, 0 KB remains"));
  });

  /**
   * The one number that changes an error's meaning rather than its size.
   * Masking it made two different test outcomes look like one repeated wall.
   */
  it("keeps distinct exit codes distinct", () => {
    expect(errorIdentity("command_exit_nonzero", "Command exited with status 1"))
      .not.toBe(errorIdentity("command_exit_nonzero", "Command exited with status 2"));
    expect(errorIdentity("command_exit_nonzero", "Command exited with status 1"))
      .toBe(errorIdentity("command_exit_nonzero", "Command exited with status 1"));
  });

  it("stays silent on a first failure and speaks on the repeat", () => {
    expect(repeatedFailureAdvice(1, "read_artifact")).toBeNull();
    expect(repeatedFailureAdvice(2, "read_artifact")).toContain("Do not repeat it");
  });
});

function seed(db: any, workspacePath: string, prompt: string) {
  const iso = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: iso });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: iso, updatedAt: iso });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: iso, updatedAt: iso });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: iso });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: iso, updatedAt: iso });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: iso,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: iso });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

describe("an exhausted read budget does not brick the rest of the task", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-budget-"))); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  /**
   * The DropSort loop: a big read spends the task ceiling, and every later read
   * — including a small, obviously-affordable one — is refused. The refusal must
   * say the budget is already spent and, on the repeat, tell the model to stop.
   */
  it("surfaces the first refusal, then marks an identical retry as a wall", async () => {
    seed(db, ws, "inspect the sources");
    writeFileSync(join(ws, "big.txt"), "x".repeat(90_000));
    writeFileSync(join(ws, "cli.py"), "print('hi')\n".repeat(400));
    const provider = new MockProvider({
      chunks: [
        [tool("big", "read_file", { path: "big.txt" }), done],
        [tool("big-2", "read_file", { path: "big.txt" }), done],
        // The same oversized read again — the loop v0.8.0 could not break out of.
        [tool("big-3", "read_file", { path: "big.txt" }), done],
        [tool("small", "read_file", { path: "cli.py" }), done],
        [text("I have what I need from the sources."), done],
        [text("Nothing further to inspect."), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 12, maxContextBytes: 100_000 });

    const calls = conversationsRepository(db).listToolCallsForTask("t");
    const byId = (id: string) => calls.find((call: any) => call.id === id);
    expect(byId("big")?.status).toBe("completed");
    // The second big read does not fit; it is refused with the honest reason.
    expect(byId("big-2")?.status).toBe("failed");
    expect(byId("big-2")?.errorMessage).toContain("already pulled");

    // The refused read was not charged, so the small file still fits. Under
    // v0.8.0's ever-growing counter this read failed too — the exact reason a
    // 5 KB source file became unreadable behind a 512 KB ceiling.
    expect(byId("small")?.status).toBe("completed");

    const advisories = taskRecordsRepository(db).listEvents("t")
      .filter((e: any) => e.type === "task.progress_warning" && e.payload?.reason === "repeated_identical_failure");
    expect(advisories.length).toBeGreaterThan(0);
    expect(advisories[0]?.payload?.message).toContain("Do not repeat it");
  });
});
