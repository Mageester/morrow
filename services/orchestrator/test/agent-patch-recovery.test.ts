import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { mkdtempSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function seedYolo(db: any, workspacePath: string) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "recover patch", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
}

const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });
const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const rawTool = (id: string, name: string, rawArguments: string) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: rawArguments } }] });

const stalePatch = [
  "--- a/index.html",
  "+++ b/index.html",
  "@@ -1,3 +1,3 @@",
  " <main>",
  "-  <h1>stale</h1>",
  "+  <h1>improved</h1>",
  " </main>",
  "",
].join("\n");

const regeneratedPatch = [
  "--- a/index.html",
  "+++ b/index.html",
  "@@ -1,3 +1,3 @@",
  " <main>",
  "-  <h1>current</h1>",
  "+  <h1>improved</h1>",
  " </main>",
  "",
].join("\n");

const noOpPatch = [
  "--- a/index.html",
  "+++ b/index.html",
  "@@ -1,3 +1,3 @@",
  " <main>",
  "-  <h1>current</h1>",
  "+  <h1>current</h1>",
  " </main>",
  "",
].join("\n");

const malformedHunkPatch = [
  "--- a/index.html",
  "+++ b/index.html",
  "@@ -1,3 +1,5 @@",
  " <main>",
  "-  <h1>current</h1>",
  "+  <h1>improved</h1>",
  " </main>",
  "",
].join("\n");

describe("agent patch recovery", () => {
  let db: any;
  let ws: string;

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-patch-recovery-")));
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns current-file feedback for a stale patch against a file created earlier, then applies a regenerated patch", async () => {
    seedYolo(db, ws);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new MockProvider({
      chunks: [
        [tool("create", "create_file", { path: "index.html", content: "<main>\n  <h1>current</h1>\n</main>\n" }), done],
        [tool("stale", "propose_patch", { patch: stalePatch, explanation: "stale improvement", files: ["index.html"] }), done],
        [tool("regen", "propose_patch", { patch: regeneratedPatch, explanation: "regenerated improvement", files: ["index.html"] }), done],
        [text("finished"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    try {
      runner.run("t");
      await runner.waitFor("t");
    } finally {
      warn.mockRestore();
    }

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(readFileSync(join(ws, "index.html"), "utf8")).toBe("<main>\n  <h1>improved</h1>\n</main>\n");

    const calls = conversationsRepository(db).listToolCallsForTask("t");
    const stale = calls.find((c: any) => c.id === "stale")!;
    expect(stale.status).toBe("failed");
    const feedback = JSON.parse(stale.resultJson!);
    expect(feedback.kind).toBe("patch_recovery_feedback");
    expect(feedback.targetFile).toBe("index.html");
    expect(feedback.currentFile.content).toContain("<h1>current</h1>");
    expect(feedback.instruction).toMatch(/Regenerate the patch against currentFile\.content/);
    expect(feedback.retryExhausted).toBe(false);

    const regenerated = calls.find((c: any) => c.id === "regen")!;
    expect(regenerated.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("t").some((e: any) => e.type === "patch.recovery_feedback")).toBe(true);
    expect(taskRecordsRepository(db).listAgentStates("t").map((s: any) => s.state)).toEqual([
      "idle",
      "understanding",
      "planning",
      "executing_tool",
      "proposing_changes",
      "applying_changes",
      "observing",
      "executing_tool",
      "proposing_changes",
      "observing",
      "executing_tool",
      "proposing_changes",
      "applying_changes",
      "observing",
      "completed",
    ]);
  });

  it("marks a repeated stale patch as exhausted on the second unchanged failure", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("create", "create_file", { path: "index.html", content: "<main>\n  <h1>current</h1>\n</main>\n" }), done],
        [tool("stale-1", "propose_patch", { patch: stalePatch, explanation: "stale improvement", files: ["index.html"] }), done],
        [tool("stale-2", "propose_patch", { patch: stalePatch, explanation: "stale improvement", files: ["index.html"] }), done],
        [text("could not apply safely"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(readFileSync(join(ws, "index.html"), "utf8")).toContain("<h1>current</h1>");
    const calls = conversationsRepository(db).listToolCallsForTask("t");
    const second = JSON.parse(calls.find((c: any) => c.id === "stale-2")!.resultJson!);
    expect(second.retryExhausted).toBe(true);
    expect(second.instruction).toMatch(/Stop cleanly/);
    const recoveryEvents = taskRecordsRepository(db).listEvents("t").filter((e: any) => e.type === "patch.recovery_feedback");
    expect(recoveryEvents).toHaveLength(2);
  });

  it("reports malformed provider tool arguments without corrupting patch state", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [rawTool("bad", "propose_patch", "{\"patch\":"), done],
        [text("correcting"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    const bad = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.id === "bad")!;
    expect(bad.status).toBe("failed");
    expect(JSON.parse(bad.resultJson!)).toMatchObject({
      kind: "malformed_tool_arguments",
      toolName: "propose_patch",
    });
    expect(taskRecordsRepository(db).listAgentStates("t").map((s: any) => s.state)).not.toContain("applying_changes");
  });

  it("rejects a no-op edit patch so providers cannot report unapplied improvements as completed", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("create", "create_file", { path: "index.html", content: "<main>\n  <h1>current</h1>\n</main>\n" }), done],
        [tool("noop", "propose_patch", { patch: noOpPatch, explanation: "claim improvement", files: ["index.html"] }), done],
        [text("stopped cleanly"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(readFileSync(join(ws, "index.html"), "utf8")).toBe("<main>\n  <h1>current</h1>\n</main>\n");
    const noop = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.id === "noop")!;
    expect(noop.status).toBe("failed");
    expect(JSON.parse(noop.resultJson!)).toMatchObject({
      kind: "patch_no_effect",
      targetFile: "index.html",
    });
  });

  it("returns actionable feedback for malformed hunk line-count mismatches", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("create", "create_file", { path: "index.html", content: "<main>\n  <h1>current</h1>\n</main>\n" }), done],
        [tool("bad-hunk", "propose_patch", { patch: malformedHunkPatch, explanation: "bad hunk", files: ["index.html"] }), done],
        [text("stopped cleanly"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(readFileSync(join(ws, "index.html"), "utf8")).toBe("<main>\n  <h1>current</h1>\n</main>\n");
    const bad = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.id === "bad-hunk")!;
    expect(bad.status).toBe("failed");
    const feedback = JSON.parse(bad.resultJson!);
    expect(feedback).toMatchObject({
      kind: "patch_recovery_feedback",
      conflictCategory: "malformed_patch",
      targetFile: "index.html",
    });
    expect(feedback.currentFile.content).toContain("<h1>current</h1>");
    expect(feedback.instruction).toMatch(/Re-read|reread|currentFile\.content/i);
  });

  it("does not count narration around failed patch calls as observable progress", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("create", "create_file", { path: "index.html", content: "<main>\n  <h1>current</h1>\n</main>\n" }), done],
        [text("Trying a visual improvement."), tool("bad-1", "propose_patch", { patch: malformedHunkPatch, explanation: "bad hunk 1", files: ["index.html"] }), done],
        [text("Trying again with more detail."), tool("bad-2", "propose_patch", { patch: malformedHunkPatch.replace("+  <h1>improved</h1>", "+  <h1>better</h1>"), explanation: "bad hunk 2", files: ["index.html"] }), done],
        [text("One more attempt."), tool("bad-3", "propose_patch", { patch: malformedHunkPatch.replace("+  <h1>improved</h1>", "+  <h1>best</h1>"), explanation: "bad hunk 3", files: ["index.html"] }), done],
        [text("should not reach this turn"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    expect(readFileSync(join(ws, "index.html"), "utf8")).toBe("<main>\n  <h1>current</h1>\n</main>\n");
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.progress_warning")).toBe(true);
    expect(conversationsRepository(db).listMessages("c").find((m: any) => m.id === "ma")?.streamingState).toBe("interrupted");
  });
});
