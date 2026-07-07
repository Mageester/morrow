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
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function seedYolo(db: any, workspacePath: string) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "make a file", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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

function run(db: any, provider: MockProvider, maxTurns = 8) {
  const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns }));
  runner.run("t");
  return runner.waitFor("t");
}
function calls(db: any) { return conversationsRepository(db).listToolCallsForTask("t"); }
function states(db: any) { return taskRecordsRepository(db).listAgentStates("t").map((s: any) => s.state); }
function argEvents(db: any) { return taskRecordsRepository(db).listEvents("t").filter((e: any) => e.type === "tool.arguments_rejected"); }

describe("agent tool-argument recovery", () => {
  let db: any;
  let ws: string;
  let warn: any;

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-toolargs-")));
    db = openDatabase(":memory:");
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    try { db.close(); } catch {}
    rmSync(ws, { recursive: true, force: true });
  });

  it("repairs fenced arguments transparently and completes without a rejection", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [rawTool("fenced", "create_file", "```json\n{\"path\":\"note.txt\",\"content\":\"hello\"}\n```"), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(readFileSync(join(ws, "note.txt"), "utf8")).toBe("hello");
    expect(calls(db).find((c: any) => c.id === "fenced")!.status).toBe("completed");
    expect(argEvents(db)).toHaveLength(0);
  });

  it("returns structured feedback for truncated arguments, then applies a corrected retry", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [rawTool("bad", "create_file", "{\"path\":\"note.txt\",\"content\":\"hi"), done],
        [tool("good", "create_file", { path: "note.txt", content: "hi" }), done],
        [text("finished"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(readFileSync(join(ws, "note.txt"), "utf8")).toBe("hi");

    const bad = calls(db).find((c: any) => c.id === "bad")!;
    expect(bad.status).toBe("failed");
    const feedback = JSON.parse(bad.resultJson!);
    expect(feedback).toMatchObject({
      kind: "malformed_tool_arguments",
      toolName: "create_file",
      reason: "truncated_json",
      retryExhausted: false,
    });
    expect(feedback.expectedSchema).toContain("path");
    expect(feedback.instruction).toMatch(/single valid JSON object/);

    expect(calls(db).find((c: any) => c.id === "good")!.status).toBe("completed");
    expect(argEvents(db)).toHaveLength(1);
    expect(states(db)).toEqual([
      "idle",
      "understanding",
      "planning",
      "executing_tool",
      "observing",
      "executing_tool",
      "proposing_changes",
      "applying_changes",
      "observing",
      "completed",
    ]);
  });

  it("stops cleanly after a second malformed retry for the same tool", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [rawTool("bad1", "create_file", "{\"path\":\"note.txt\",\"content\":\"hi"), done],
        [rawTool("bad2", "create_file", "{\"path\":\"note.txt\",\"content\":\"ho"), done],
        [text("could not parse arguments"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const second = JSON.parse(calls(db).find((c: any) => c.id === "bad2")!.resultJson!);
    expect(second).toMatchObject({ kind: "malformed_tool_arguments", retryExhausted: true });
    expect(second.instruction).toMatch(/Stop cleanly/);
    expect(argEvents(db)).toHaveLength(2);
    // Nothing was written for either malformed attempt.
    expect(readdirSync(ws)).toHaveLength(0);
    expect(states(db)).not.toContain("applying_changes");
  });

  it("rejects a missing required field without mutating the filesystem", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("nopath", "create_file", { content: "orphan" }), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const nopath = JSON.parse(calls(db).find((c: any) => c.id === "nopath")!.resultJson!);
    expect(nopath).toMatchObject({
      kind: "invalid_tool_arguments",
      toolName: "create_file",
      invalidField: "path",
      problem: "missing",
    });
    expect(readdirSync(ws)).toHaveLength(0);
    expect(states(db)).not.toContain("applying_changes");
  });

  it("rejects an absolute path argument as a structured correction", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("abs", "create_file", { path: "C:\\Windows\\evil.txt", content: "x" }), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const abs = JSON.parse(calls(db).find((c: any) => c.id === "abs")!.resultJson!);
    expect(abs).toMatchObject({ kind: "invalid_tool_arguments", invalidField: "path", problem: "absolute_path" });
    expect(existsSync(join(ws, "evil.txt"))).toBe(false);
    expect(states(db)).not.toContain("applying_changes");
  });

  it("rejects a wrong argument type before dispatch", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("wtype", "propose_patch", { patch: 123, explanation: "x", files: [] }), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const wtype = JSON.parse(calls(db).find((c: any) => c.id === "wtype")!.resultJson!);
    expect(wtype).toMatchObject({ kind: "invalid_tool_arguments", invalidField: "patch", problem: "wrong_type", expected: "string" });
    expect(states(db)).not.toContain("applying_changes");
  });

  it("rejects merged tool calls as ambiguous and writes nothing", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [rawTool("merged", "create_file", "{\"path\":\"a.txt\",\"content\":\"x\"}{\"path\":\"b.txt\",\"content\":\"y\"}"), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const merged = JSON.parse(calls(db).find((c: any) => c.id === "merged")!.resultJson!);
    expect(merged).toMatchObject({ kind: "malformed_tool_arguments", reason: "multiple_tool_calls_merged" });
    expect(readdirSync(ws)).toHaveLength(0);
    expect(states(db)).not.toContain("applying_changes");
  });
});
