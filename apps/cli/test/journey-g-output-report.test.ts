import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, buildServer, TaskRunner, executeAgentChatTask, MockProvider } from "@morrow/orchestrator";
import { MorrowApi } from "../src/client/api.js";
import { buildTaskReport, selectCanonicalFinalAnswer } from "../src/terminal/output-report.js";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Journey G's orchestrator-side test proves the durable repositories (task
 * status, canonical_task_answers, plan steps) are correct. This file proves
 * the *actual* `/output full` path — `buildTaskReport` /
 * `selectCanonicalFinalAnswer` in apps/cli/src/terminal/output-report.ts,
 * fed by the real `MorrowApi` HTTP client against a real orchestrator server
 * — agrees with those same durable repositories, for both a genuine
 * completion and the interrupted failure-class cases. This is the exact
 * code path `/output full` runs (see apps/cli/src/commands/chat.ts's
 * "output" case), not a reimplementation of it.
 */

function toolChunk(id: string, name: string, args: unknown) {
  return { type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] };
}
const done = { type: "done" as const };
const textChunk = (t: string) => ({ type: "text" as const, text: t });

const REPEATED_NARRATION = "Good — clean working tree. Let me inspect the relevant source files to find the bug.";
const REQUEST = "There is a bug in big.js: add() gives the wrong result. Read the file, fix the bug, and verify with a test.";

const FIX_PATCH = "--- a/big.js\n+++ b/big.js\n@@ -902,3 +902,3 @@\n function add(a, b) {\n-  return a - b; // BUG: should add, not subtract\n+  return a + b;\n }\n";

function largeSourceFixture(): string {
  const helpers = Array.from({ length: 900 }, (_, i) => `function helper${i}(x) { return x + ${i}; }`).join("\n");
  return `${helpers}\n\nfunction add(a, b) {\n  return a - b; // BUG: should add, not subtract\n}\n\nmodule.exports = { add };\n`;
}

async function waitForTerminal(api: MorrowApi, taskId: string): Promise<string> {
  const start = Date.now();
  let status = "";
  while (Date.now() - start < 15000) {
    status = (await api.getTask(taskId)).task.status;
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)) return status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for task ${taskId} to reach a terminal status (last: ${status})`);
}

describe("Journey G — /output full consistency with durable repositories", () => {
  let db: any;
  let app: any;
  let api: MorrowApi;
  let ws: string;
  let provider: MockProvider;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    process.env.MOCK_PROVIDER = "true";
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-journey-g-output-")));
    writeFileSync(join(ws, "big.js"), largeSourceFixture());
    writeFileSync(
      join(ws, "big.test.js"),
      "const assert = require('assert');\nconst { add } = require('./big.js');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('ok');\n"
    );
    db = openDatabase(":memory:");
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({
      db: d.db, taskId: d.taskId, provider, maxTurns: 8,
      ...(d.abortSignal ? { abortSignal: d.abortSignal } : {}),
    }));
    app = buildServer({ db, runner, sseIntervalMs: 5 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    api = new MorrowApi(`http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (app) { try { await app.close(); } catch { /* ignore */ } }
    if (db) { try { db.close(); } catch { /* ignore */ } }
    rmSync(ws, { recursive: true, force: true });
  });

  /** Builds the exact report `/output full` builds (mirrors chat.ts's "output" case). */
  async function outputFullReport(taskId: string, conversationId: string) {
    const [aggregate, messages] = await Promise.all([api.getTask(taskId), api.listMessages(conversationId)]);
    const finalAnswer = [...messages].reverse().find((m) => m.taskId === taskId && m.role === "assistant")?.content ?? null;
    const legacyFallback = finalAnswer ?? undefined;
    const selected = selectCanonicalFinalAnswer(aggregate, legacyFallback);
    const report = buildTaskReport(aggregate, { kind: "full", ...(legacyFallback ? { legacyFinalAnswerFallback: legacyFallback } : {}) });
    return { aggregate, report, selected };
  }

  function canonicalAnswerRow(taskId: string): { content: string } | undefined {
    return db.prepare("SELECT content FROM canonical_task_answers WHERE task_id=?").get(taskId) as { content: string } | undefined;
  }

  it("reports the same task id, completed status, and canonical answer as the durable repositories", async () => {
    provider = new MockProvider({
      delayMs: 1,
      chunks: [
        [toolChunk("r1", "list_files", { path: "." }), done],
        [toolChunk("r2", "read_file", { path: "big.js" }), done],
        [textChunk(REPEATED_NARRATION), toolChunk("s1", "search_text", { query: "add" }), done],
        [textChunk(REPEATED_NARRATION), toolChunk("s2", "search_text", { query: "BUG" }), done],
        [toolChunk("p1", "propose_patch", { patch: FIX_PATCH, explanation: "fix add() to actually add", files: ["big.js"] }), done],
        [toolChunk("v1", "run_command", { executable: "node", args: ["big.test.js"], purpose: "verify the fix" }), done],
        [textChunk("Fixed add() (it was subtracting); big.test.js now passes."), done],
      ],
    });

    const project = await api.createProject("Journey G Success", ws);
    const conversation = await api.createConversation(project.id, "g");
    const sent = await api.sendMessage(conversation.id, REQUEST, { preset: "best-quality", mode: "agent", autoApprove: true });
    const taskId = sent.task.id;

    const status = await waitForTerminal(api, taskId);
    expect(status).toBe("completed");

    const durableCanonical = canonicalAnswerRow(taskId);
    expect(durableCanonical).toBeDefined();
    expect(durableCanonical!.content).toContain("Fixed add()");
    expect(durableCanonical!.content).not.toContain(REPEATED_NARRATION);

    const { aggregate, report, selected } = await outputFullReport(taskId, conversation.id);

    // Same task id and terminal status as the durable task repository.
    expect(aggregate.task.id).toBe(taskId);
    expect(aggregate.task.status).toBe("completed");
    expect(report).toContain(`Task: ${taskId.slice(0, 8)} (${taskId})`);
    expect(report).toContain("Status: completed");

    // Same canonical answer as the durable canonical_task_answers row.
    expect(selected.kind).toBe("final");
    if (selected.kind === "final") expect(selected.text.trim()).toBe(durableCanonical!.content.trim());
    // The "## Final Answer" section specifically — not the report as a whole,
    // which legitimately keeps the repeated narration visible under
    // "## Intermediate Activity" for transparency — must be the canonical
    // answer, not the repeated narration.
    const finalAnswerSection = report.split("## Final Answer")[1]!.split("\n## ")[0]!;
    expect(finalAnswerSection).toContain("Fixed add()");
    expect(finalAnswerSection).not.toContain(REPEATED_NARRATION);
  }, 20000);

  it("reports the same task id and truthful interrupted status when delivery evidence is missing (no fabricated canonical answer)", async () => {
    provider = new MockProvider({
      delayMs: 1,
      chunks: [
        [toolChunk("r1", "read_file", { path: "big.js" }), done],
        [textChunk("Investigating the reported issue."), toolChunk("s1", "search_text", { query: "add" }), done],
        [textChunk("The add() function looks fine to me on inspection; no change appears necessary."), done],
      ],
    });

    const project = await api.createProject("Journey G Missing Delivery", ws);
    const conversation = await api.createConversation(project.id, "g");
    const sent = await api.sendMessage(conversation.id, REQUEST, { preset: "best-quality", mode: "agent", autoApprove: true });
    const taskId = sent.task.id;

    const status = await waitForTerminal(api, taskId);
    expect(status).toBe("interrupted");
    expect(canonicalAnswerRow(taskId)).toBeUndefined();

    const { aggregate, report } = await outputFullReport(taskId, conversation.id);
    expect(aggregate.task.id).toBe(taskId);
    expect(aggregate.task.status).toBe("interrupted");
    expect(report).toContain(`Task: ${taskId.slice(0, 8)} (${taskId})`);
    expect(report).toContain("Status: interrupted");
    expect(report).not.toContain("Status: completed");
  }, 20000);

  it("reports the same task id and truthful interrupted status when the final turn duplicates earlier narration", async () => {
    provider = new MockProvider({
      delayMs: 1,
      chunks: [
        [toolChunk("r1", "read_file", { path: "big.js" }), done],
        [textChunk(REPEATED_NARRATION), toolChunk("s1", "search_text", { query: "add" }), done],
        [textChunk(REPEATED_NARRATION), toolChunk("s2", "search_text", { query: "return" }), done],
        [textChunk(REPEATED_NARRATION), done],
      ],
    });

    const project = await api.createProject("Journey G Duplicate Narration", ws);
    const conversation = await api.createConversation(project.id, "g");
    const sent = await api.sendMessage(conversation.id, REQUEST, { preset: "best-quality", mode: "agent", autoApprove: true });
    const taskId = sent.task.id;

    const status = await waitForTerminal(api, taskId);
    expect(status).toBe("interrupted");
    expect(canonicalAnswerRow(taskId)).toBeUndefined();

    const { aggregate, report } = await outputFullReport(taskId, conversation.id);
    expect(aggregate.task.id).toBe(taskId);
    expect(aggregate.task.status).toBe("interrupted");
    expect(report).toContain(`Task: ${taskId.slice(0, 8)} (${taskId})`);
    expect(report).toContain("Status: interrupted");
    expect(report).not.toContain("Status: completed");
  }, 20000);
});
