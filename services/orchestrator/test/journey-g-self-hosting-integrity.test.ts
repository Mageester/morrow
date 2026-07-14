import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { changeSetsRepository } from "../src/repositories/change-sets.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Journey G reproduces the failure class captured in the real Morrow-manages-
 * Morrow self-hosting task `1fcbc8ab-7827-4086-a6e7-b0477e752aaa`: 37 tool
 * calls (2 failed), 503,751 input tokens, no implementation and no Git diff,
 * the same intermediate narration repeated dozens of times, that repeated
 * narration stored as the "final answer", every plan step marked completed,
 * and the task reported `completed`. This file exercises the real
 * `executeAgentChatTask` execution path, real sqlite-backed repositories,
 * and a disposable Git repository — not a standalone helper — with a
 * deterministic provider fixture standing in for the live model.
 */

/** Wraps a provider to capture the exact request envelope (message history) sent on every call, so the request-size bound can be measured against the real provider-projection path instead of just counting tool calls. */
class RequestCapturingProvider {
  readonly requestSizes: number[] = [];
  constructor(private readonly inner: MockProvider) {}
  async *streamChat(messages: unknown[], options: any) {
    this.requestSizes.push(JSON.stringify(messages).length);
    yield* this.inner.streamChat(messages as any, options);
  }
}

function initGitRepo(ws: string) {
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: ws });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: ws });
  execFileSync("git", ["add", "-A"], { cwd: ws });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: ws });
}

/** A large (~40KB) source file — big enough to require real inspection, well under the 100KB per-file read limit. */
function largeSourceFixture(): string {
  const helpers = Array.from({ length: 900 }, (_, i) => `function helper${i}(x) { return x + ${i}; }`).join("\n");
  return `${helpers}\n\nfunction add(a, b) {\n  return a - b; // BUG: should add, not subtract\n}\n\nmodule.exports = { add };\n`;
}

function seed(db: any, workspacePath: string, prompt: string) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  const conv = conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
  return { conv };
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

const REPEATED_NARRATION = "Good — clean working tree. Let me inspect the relevant source files to find the bug.";
const REQUEST = "There is a bug in big.js: add() gives the wrong result. Read the file, fix the bug, and verify with a test.";

describe("Journey G — self-hosting implementation integrity", () => {
  let db: any;
  let ws: string;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-journey-g-")));
    writeFileSync(join(ws, "big.js"), largeSourceFixture());
    writeFileSync(
      join(ws, "big.test.js"),
      "const assert = require('assert');\nconst { add } = require('./big.js');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('ok');\n"
    );
    initGitRepo(ws);
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(ws, { recursive: true, force: true });
  });

  it("completes a real implementation task once: bounded tool calls, one canonical answer, no repeated narration, verified diff", async () => {
    seed(db, ws, REQUEST);
    const provider = new MockProvider({
      chunks: [
        [tool("r1", "list_files", { path: "." }), done],
        [tool("r2", "read_file", { path: "big.js" }), done],
        // Two intermediate turns restate the same orientation narrative
        // (realistic model behavior) while still making distinct, real
        // progress via distinct tool calls — this must not be confused with
        // the failure class of repeating narration AS the final answer.
        [text(REPEATED_NARRATION), tool("s1", "search_text", { query: "add" }), done],
        [text(REPEATED_NARRATION), tool("s2", "search_text", { query: "BUG" }), done],
        [tool("p1", "propose_patch", {
          patch: "--- a/big.js\n+++ b/big.js\n@@ -902,3 +902,3 @@\n function add(a, b) {\n-  return a - b; // BUG: should add, not subtract\n+  return a + b;\n }\n",
          explanation: "fix add() to actually add",
          files: ["big.js"],
        }), done],
        [tool("v1", "run_command", { executable: "node", args: ["big.test.js"], purpose: "verify the fix" }), done],
        [text("Fixed add() (it was subtracting); big.test.js now passes."), done],
      ],
      delayMs: 1,
    });
    const capturing = new RequestCapturingProvider(provider);
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider: capturing as any, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    // Terminal status and durable task status agree, and no /continue was needed.
    const task = taskRepository(db).getTaskById("t")!;
    expect(task.status).toBe("completed");

    // Exactly one canonical answer, distinct from the repeated narration.
    const continuity = executionContinuityRepository(db);
    const canonical = continuity.getCanonicalAnswer("t");
    expect(canonical).not.toBeNull();
    expect(canonical!.content).toContain("Fixed add()");
    expect(canonical!.content).not.toContain(REPEATED_NARRATION);

    // Each intermediate assistant turn is stored exactly once, and no turn's
    // stored text recursively contains an earlier turn's text concatenated in
    // (the beta.30 "turn N contains turns 1..N-1" defect class).
    const turns = continuity.listProviderTurns("t");
    const turnKeys = new Set(turns.map((turn: any) => turn.turnKey));
    expect(turnKeys.size).toBe(turns.length);
    const narrationTurns = turns.filter((turn: any) => turn.assistantText.includes(REPEATED_NARRATION));
    expect(narrationTurns).toHaveLength(2);
    for (const turn of narrationTurns) {
      const occurrences = turn.assistantText.split(REPEATED_NARRATION).length - 1;
      expect(occurrences).toBe(1);
    }

    // Plan steps only completed alongside real delivery evidence.
    const steps = taskRecordsRepository(db).listPlanSteps("t");
    expect(steps.every((step: any) => step.status === "completed")).toBe(true);

    // An implementation task cannot complete without a relevant Git/workspace diff.
    const changeSets = changeSetsRepository(db).listByTask("t");
    expect(changeSets.length).toBeGreaterThan(0);
    expect(changeSets.some((cs: any) => cs.diff.includes("return a + b;"))).toBe(true);
    const gitDiff = execFileSync("git", ["diff", "HEAD", "--", "big.js"], { cwd: ws }).toString();
    expect(gitDiff).toContain("return a + b;");

    // Verification after the final change passed.
    const verifyCall = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.id === "v1");
    expect(verifyCall?.status).toBe("completed");

    // Tool calls, turns, and request size stayed bounded.
    const toolCalls = conversationsRepository(db).listToolCallsForTask("t");
    expect(toolCalls.length).toBeLessThanOrEqual(6);
    expect(turns.length).toBeLessThanOrEqual(7);

    // Every provider request envelope stayed under an explicit bound, and the
    // envelope did not recursively balloon as the repeated narration turns
    // accumulated (the beta.30 defect class this journey targets was a
    // request/response accumulator growing with every duplicated turn, not
    // just tool-call/turn *counts*).
    expect(capturing.requestSizes.length).toBeGreaterThan(0);
    for (const size of capturing.requestSizes) expect(size).toBeLessThan(80_000);
    const sizeAfterFileRead = capturing.requestSizes[2]!; // request for the turn after read_file's result first enters context
    const finalRequestSize = capturing.requestSizes[capturing.requestSizes.length - 1]!;
    expect(finalRequestSize - sizeAfterFileRead).toBeLessThan(6_000);

    // Terminal event log has exactly one completion, no interruption.
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.filter((e: any) => e.type === "task.completed")).toHaveLength(1);
    expect(events.some((e: any) => e.type === "task.interrupted")).toBe(false);
  });

  it("never lets repeated narration become the canonical final answer or a false completion (proven root cause)", async () => {
    seed(db, ws, REQUEST);
    // The model investigates but never once calls a write tool, then — after
    // several turns each pairing the *same* narration with a distinct
    // read-only tool call — gives up and repeats that exact narration one
    // more time with NO tool call attached. This is the literal shape of the
    // corpus failure: dozens of duplicated narration turns and no diff.
    const provider = new MockProvider({
      chunks: [
        [tool("r1", "read_file", { path: "big.js" }), done],
        [text(REPEATED_NARRATION), tool("s1", "search_text", { query: "add" }), done],
        [text(REPEATED_NARRATION), tool("s2", "search_text", { query: "return" }), done],
        [text(REPEATED_NARRATION), tool("s3", "search_text", { query: "module" }), done],
        [text(REPEATED_NARRATION), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    const task = taskRepository(db).getTaskById("t")!;
    // Truthful interruption, never a false "completed".
    expect(task.status).toBe("interrupted");

    // No canonical answer was ever recorded for the duplicated narration.
    const continuity = executionContinuityRepository(db);
    expect(continuity.getCanonicalAnswer("t")).toBeNull();

    // Plan steps cannot all be marked completed when delivery evidence is missing.
    const steps = taskRecordsRepository(db).listPlanSteps("t");
    expect(steps.some((step: any) => step.status !== "completed")).toBe(true);

    // No Git diff was produced — an implementation task without one must not complete.
    const gitDiff = execFileSync("git", ["diff", "HEAD", "--", "big.js"], { cwd: ws }).toString();
    expect(gitDiff).toBe("");
    expect(changeSetsRepository(db).listByTask("t")).toHaveLength(0);

    // Terminal status and durable task status agree; no completed event was ever emitted.
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.completed")).toBe(false);
    expect(events.some((e: any) => e.type === "task.interrupted")).toBe(true);
  });

  it("does not complete an implementation request on a NOVEL final answer alone when no write tool ever ran (general missing-delivery protection)", async () => {
    seed(db, ws, REQUEST);
    // Unlike the duplicate-narration case above, this final answer is
    // genuinely novel — it never repeats earlier text. The
    // duplicatesPriorNarration gate alone would let this one through. The
    // request still explicitly asks for a file change (REQUEST says "fix the
    // bug ... and verify"), and the model still never once calls a write
    // tool, so completion must be refused on missing delivery evidence, not
    // on duplicated text.
    const provider = new MockProvider({
      chunks: [
        [tool("r1", "read_file", { path: "big.js" }), done],
        [text("Investigating the reported issue."), tool("s1", "search_text", { query: "add" }), done],
        [text("The add() function looks fine to me on inspection; no change appears necessary."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    const task = taskRepository(db).getTaskById("t")!;
    expect(task.status).toBe("interrupted");

    const continuity = executionContinuityRepository(db);
    expect(continuity.getCanonicalAnswer("t")).toBeNull();

    const steps = taskRecordsRepository(db).listPlanSteps("t");
    expect(steps.some((step: any) => step.status !== "completed")).toBe(true);

    expect(changeSetsRepository(db).listByTask("t")).toHaveLength(0);
    const gitDiff = execFileSync("git", ["diff", "HEAD", "--", "big.js"], { cwd: ws }).toString();
    expect(gitDiff).toBe("");

    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.completed")).toBe(false);
    expect(events.some((e: any) => e.type === "task.interrupted")).toBe(true);
  });

  it("still completes a plain read-only/Ask request with no write tool call and no diff (does not over-fire on requests that never asked for a change)", async () => {
    seed(db, ws, "What does the add() function in big.js do? No changes needed, just explain it.");
    const provider = new MockProvider({
      chunks: [
        [tool("r1", "read_file", { path: "big.js" }), done],
        [text("add(a, b) currently returns a - b, which looks like a subtraction bug relative to its name."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    const task = taskRepository(db).getTaskById("t")!;
    expect(task.status).toBe("completed");
    const continuity = executionContinuityRepository(db);
    expect(continuity.getCanonicalAnswer("t")).not.toBeNull();
  });
});
