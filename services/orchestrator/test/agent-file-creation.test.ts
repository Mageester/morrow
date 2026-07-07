import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
function seedYolo(db: any, workspacePath: string) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "build it", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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

  it("refuses to clobber an existing file through create_file", async () => {
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

    // The original content is preserved; the second create_file failed cleanly.
    expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("original\n");
    const calls = conversationsRepository(db).listToolCallsForTask("t").filter((c: any) => c.toolName === "create_file");
    expect(calls[0]!.status).toBe("completed");
    expect(calls[1]!.status).toBe("failed");
    expect(calls[1]!.errorMessage).toMatch(/already exists/i);
  });
});
