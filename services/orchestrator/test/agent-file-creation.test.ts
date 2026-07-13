import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { changeSetsRepository } from "../src/repositories/change-sets.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Seed an agent-mode task with YOLO (autoApprove) against a real workspace. */
function seedYolo(db: any, workspacePath: string, prompt = "build it") {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const tools = (...calls: Array<{ id: string; name: string; args: unknown }>) => ({
  type: "tool_call" as const,
  toolCalls: calls.map((call, index) => ({
    id: call.id,
    index,
    type: "function" as const,
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  })),
});
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

describe("agent file creation under YOLO", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-create-"))); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("creates directories and files, runs a command, and reflects them in change sets — no human, no crash", async () => {
    seedYolo(db, ws);
    const appContent = "import React from 'react';\n\nexport function App() {\n  return <div>Todo</div>;\n}\n";
    const provider = new MockProvider({
      chunks: [
        [tool("d1", "create_directory", { path: "src" }), done],
        [tool("f1", "create_file", { path: "package.json", content: '{\n  "name": "todo-app"\n}\n', purpose: "manifest" }), done],
        [tool("f2", "create_file", { path: "src/App.tsx", content: appContent }), done],
        [tool("l1", "list_files", { path: "." }), done],
        [tool("c1", "run_command", { executable: "node", args: ["-e", "0"], purpose: "verify" }), done],
        [text("built"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 12 }));
    runner.run("t");
    await runner.waitFor("t");

    // Task completed autonomously.
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");

    // Files and directory really exist on disk with the exact content.
    expect(existsSync(join(ws, "src"))).toBe(true);
    expect(existsSync(join(ws, "package.json"))).toBe(true);
    expect(readFileSync(join(ws, "src", "App.tsx"), "utf8")).toBe(appContent);
    expect(readFileSync(join(ws, "package.json"), "utf8")).toBe('{\n  "name": "todo-app"\n}\n');

    // Every tool call succeeded — no denied loop, no boundary rejection.
    const toolCalls = conversationsRepository(db).listToolCallsForTask("t");
    for (const tc of toolCalls) {
      expect(tc.status, `${tc.toolName} should not fail: ${tc.errorMessage ?? ""}`).toBe("completed");
    }

    // list_files did not claim the workspace is outside itself.
    const list = toolCalls.find((c: any) => c.toolName === "list_files");
    const listResult = JSON.parse(list!.resultJson!);
    expect(listResult.entries.map((e: any) => e.path)).toContain("package.json");

    // Approvals were all auto-approved; nothing was ever surfaced to a human.
    const approvals = approvalsRepository(db).listByTask("t");
    expect(approvals.length).toBeGreaterThanOrEqual(3); // 1 dir + 2 files
    expect(approvals.every((a) => a.status === "approved")).toBe(true);
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "approval.requested")).toBe(false);

    // The two created files are captured as applied change sets (so /diff & /changes see them).
    const changeSets = changeSetsRepository(db).listByTask("t");
    const appliedFiles = new Set<string>();
    for (const cs of changeSets) {
      expect(cs.state).toBe("applied");
      for (const f of Object.keys(cs.postApplyHashes ?? {})) appliedFiles.add(f);
    }
    expect(appliedFiles.has("package.json")).toBe(true);
    expect(appliedFiles.has("src/App.tsx")).toBe(true);
  });

  it("applies multiple file proposals emitted in one model turn without an invalid state transition", async () => {
    seedYolo(db, ws);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new MockProvider({
      chunks: [
        [
          tools(
            { id: "f1", name: "create_file", args: { path: "index.html", content: "<!doctype html>\n<div>Hello</div>\n", purpose: "page" } },
            { id: "f2", name: "create_file", args: { path: "style.css", content: "body { font-family: sans-serif; }\n", purpose: "styles" } },
            { id: "f3", name: "create_file", args: { path: "script.js", content: "console.log('ready');\n", purpose: "script" } },
          ),
          done,
        ],
        [tool("l1", "list_files", { path: "." }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    try {
      const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
      runner.run("t");
      await runner.waitFor("t");

      expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
      const toolCalls = conversationsRepository(db).listToolCallsForTask("t");
      for (const tc of toolCalls) {
        expect(tc.status, `${tc.toolName} should not fail: ${tc.errorMessage ?? ""}`).toBe("completed");
      }
      expect(readFileSync(join(ws, "index.html"), "utf8")).toContain("Hello");
      expect(readFileSync(join(ws, "style.css"), "utf8")).toContain("font-family");
      expect(readFileSync(join(ws, "script.js"), "utf8")).toContain("ready");

      expect(taskRecordsRepository(db).listAgentStates("t").map((state: any) => state.state)).toEqual([
        "idle",
        "understanding",
        "planning",
        "executing_tool",
        "proposing_changes",
        "applying_changes",
        "observing",
        "proposing_changes",
        "applying_changes",
        "observing",
        "proposing_changes",
        "applying_changes",
        "observing",
        "executing_tool",
        "observing",
        "completed",
      ]);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("agent_state_transition_rejected"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("automatically switches create_file to a backed-up edit when the target already exists", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("f1", "create_file", { path: "keep.txt", content: "original\n" }), done],
        [tool("f2", "create_file", { path: "keep.txt", content: "overwrite\n" }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    // The second create_file switched strategy to an edit and overwrote cleanly,
    // rather than dead-ending on "it already exists".
    expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("overwrite\n");
    const calls = conversationsRepository(db).listToolCallsForTask("t").filter((c: any) => c.toolName === "create_file");
    expect(calls[0]!.status).toBe("completed");
    expect(calls[1]!.status).toBe("completed");

    // The strategy switch was observable and the overwrite is an undoable change set
    // (the original content is backed up so /undo can restore it).
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "tool.strategy_switch" && (e.payload as any).to === "edit")).toBe(true);
    const changeSets = changeSetsRepository(db).listByTask("t");
    const editChange = changeSets.find((cs) => Object.keys(cs.postApplyHashes ?? {}).includes("keep.txt") && Object.keys(cs.backupReferences ?? {}).includes("keep.txt"));
    expect(editChange, "the overwrite should be captured as a backed-up change set").toBeTruthy();
  });

  it("reports patch_no_effect when an edit would leave an existing file unchanged", async () => {
    seedYolo(db, ws);
    // create_file "same.txt", then a propose_patch whose result is identical to
    // what's on disk. The edit fallback / patch apply must refuse a no-op rather
    // than record a hollow success.
    const noOpPatch = "--- a/same.txt\n+++ b/same.txt\n@@ -1,1 +1,1 @@\n-identical\n+identical\n";
    const provider = new MockProvider({
      chunks: [
        [tool("f1", "create_file", { path: "same.txt", content: "identical\n" }), done],
        [tool("f2", "propose_patch", { patch: noOpPatch, explanation: "no-op", files: ["same.txt"] }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(readFileSync(join(ws, "same.txt"), "utf8")).toBe("identical\n");
    const patchCall = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "propose_patch");
    expect(patchCall!.status).toBe("failed");
    expect(JSON.parse(patchCall!.resultJson!).kind).toBe("patch_no_effect");
  });

  it("enforces an explicit user only-file contract and rejects auxiliary scratch files", async () => {
    seedYolo(db, ws, "Create an invoice generator using only index.html, style.css, and script.js.");
    const provider = new MockProvider({
      chunks: [
        [
          tools(
            { id: "f1", name: "create_file", args: { path: "index.html", content: "<!doctype html>\n", purpose: "page" } },
            { id: "f2", name: "create_file", args: { path: "style.css", content: "body { color: white; }\n", purpose: "styles" } },
            { id: "f3", name: "create_file", args: { path: "script.js", content: "console.log('ready');\n", purpose: "script" } },
          ),
          done,
        ],
        [tool("scratch", "create_file", { path: "calc_test.js", content: "console.log(203.40);\n", purpose: "scratch calculation" }), done],
        [tool("verify", "run_command", { executable: "node", args: ["-e", "console.log((2*100*(1-.10)*1.13).toFixed(2))"], purpose: "verify calculation without writing files" }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 10 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(existsSync(join(ws, "index.html"))).toBe(true);
    expect(existsSync(join(ws, "style.css"))).toBe(true);
    expect(existsSync(join(ws, "script.js"))).toBe(true);
    expect(existsSync(join(ws, "calc_test.js"))).toBe(false);

    const scratch = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.id === "scratch");
    expect(scratch).toMatchObject({ toolName: "create_file", status: "failed" });
    expect(scratch?.errorMessage).toMatch(/outside the user's explicit allowed file list/i);

    const verify = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.id === "verify");
    expect(verify).toMatchObject({ toolName: "run_command", status: "completed" });
  });

  it("creates an ordinary source file whose name merely contains a security-related word (denied-path false-positive fix)", async () => {
    // Reproduction: creating src/checks/secrets.js was previously rejected
    // outright because the denied-name matcher treated "*secret*" as "the
    // basename contains this substring anywhere" instead of recognizing real
    // credential-file conventions. This exercises the real, unmodified
    // PERMISSION_PROFILE.deniedNamePatterns end to end through create_file.
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("f1", "create_file", { path: "src/checks/secrets.js", content: "export function checkForSecrets() { return []; }\n", purpose: "secret-scanning check" }), done],
        [tool("f2", "create_file", { path: "test/credential-detector.test.js", content: "test('detects', () => {});\n" }), done],
        [tool("f3", "create_file", { path: "docs/secrets-handling.md", content: "# Secrets handling\n" }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(existsSync(join(ws, "src/checks/secrets.js"))).toBe(true);
    expect(existsSync(join(ws, "test/credential-detector.test.js"))).toBe(true);
    expect(existsSync(join(ws, "docs/secrets-handling.md"))).toBe(true);

    const toolCalls = conversationsRepository(db).listToolCallsForTask("t");
    for (const tc of toolCalls) {
      expect(tc.status, `${tc.toolName} ${JSON.parse(tc.argsJson ?? "{}").path ?? ""} should not fail: ${tc.errorMessage ?? ""}`).toBe("completed");
    }
  });

  it("still rejects real credential-store files by the same real PERMISSION_PROFILE (containment is not weakened)", async () => {
    seedYolo(db, ws);
    // Each denied attempt is interleaved with a successful one so the run
    // keeps making observable progress (three consecutive no-progress turns
    // trips an unrelated "stalled" safeguard) — this test is only about
    // denial being real, not about recovery-loop behavior.
    const provider = new MockProvider({
      chunks: [
        [tool("f1", "create_file", { path: ".env", content: "API_KEY=abc123\n" }), done],
        [tool("ok1", "create_file", { path: "ok1.txt", content: "fine\n" }), done],
        [tool("f2", "create_file", { path: "id_rsa", content: "-----BEGIN OPENSSH PRIVATE KEY-----\n" }), done],
        [tool("ok2", "create_file", { path: "ok2.txt", content: "fine\n" }), done],
        [tool("f3", "create_file", { path: "config/credentials.json", content: '{"apiKey":"abc"}' }), done],
        [tool("f4", "create_file", { path: "notes.txt", content: "safe file after the denied ones\n" }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 12 }));
    runner.run("t");
    await runner.waitFor("t");

    // None of the denied files were written to disk.
    expect(existsSync(join(ws, ".env"))).toBe(false);
    expect(existsSync(join(ws, "id_rsa"))).toBe(false);
    expect(existsSync(join(ws, "config/credentials.json"))).toBe(false);
    // The task did not crash — it kept going and completed the safe files.
    expect(existsSync(join(ws, "ok1.txt"))).toBe(true);
    expect(existsSync(join(ws, "ok2.txt"))).toBe(true);
    expect(existsSync(join(ws, "notes.txt"))).toBe(true);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");

    const toolCalls = conversationsRepository(db).listToolCallsForTask("t");
    for (const id of ["f1", "f2", "f3"]) {
      const call = toolCalls.find((c: any) => c.id === id);
      expect(call).toMatchObject({ status: "failed" });
      expect(call!.errorMessage).toMatch(/denied path pattern/i);
    }
  });
});
