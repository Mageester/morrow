import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";

// Beta.32 packaged-acceptance regression: web missions need a dev/preview
// server that SURVIVES its run_command call so the browser can validate the
// running site. Without background:true the model resorted to racy detached
// spawns that died or leaked orphan servers. The supervised background process
// must (1) stay alive across tool calls, (2) report port readiness, and
// (3) be force-stopped when the task ends — never an orphan.

const PORT = 43_117;

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, family: 4 });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

function seed(db: any, workspacePath: string) {
  const ts = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: ts });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: ts, updatedAt: ts });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "serve the site", createdAt: ts, updatedAt: ts });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: ts });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: ts, updatedAt: ts });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: ts,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: ts });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

describe("run_command background mode (supervised servers)", () => {
  let db: any;
  let ws: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "morrow-bg-"));
    prevHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = join(ws, "home");
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = prevHome;
    try { db.close(); } catch { /* closed */ }
    rmSync(ws, { recursive: true, force: true });
  });

  it("keeps a background server alive across tool calls, reports readiness, and stops it at task end", async () => {
    seed(db, ws);
    const serverScript = `require('http').createServer((q,s)=>s.end('haloform')).listen(${PORT},'127.0.0.1')`;
    const provider = new MockProvider({
      chunks: [
        [tool("bg1", "run_command", { executable: "node", args: ["-e", serverScript], purpose: "serve the built site", background: true, readyPort: PORT }), done],
        // A later ordinary tool call — the server must still be alive here.
        [tool("chk", "run_command", { executable: "node", args: ["-e", `require('http').get('http://127.0.0.1:${PORT}/',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))`], purpose: "verify the server responds" }), done],
        [text("served and verified"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    const calls = conversationsRepository(db).listToolCallsForTask("t");
    const background = calls.find((c: any) => c.toolName === "run_command" && c.argsJson.includes("background"));
    expect(background?.status).toBe("completed");
    const backgroundResult = JSON.parse(background!.resultJson!);
    expect(backgroundResult.background).toBe(true);
    expect(backgroundResult.ready).toBe(true);
    expect(backgroundResult.status).toBe("running");

    // The in-run verification command (a SEPARATE tool call) reached the server.
    const check = calls.find((c: any) => c.toolName === "run_command" && c.argsJson.includes("statusCode"));
    expect(check?.status).toBe("completed");
    expect(JSON.parse(check!.resultJson!).exitCode).toBe(0);

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");

    // Task-end cleanup: the server must NOT outlive the task as an orphan.
    let alive = await probePort(PORT);
    for (let i = 0; i < 10 && alive; i++) {
      await new Promise((r) => setTimeout(r, 300));
      alive = await probePort(PORT);
    }
    expect(alive).toBe(false);
  }, 60_000);

  it("reports an immediately-failing background command honestly", async () => {
    seed(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("bg1", "run_command", { executable: "node", args: ["-e", "process.exit(3)"], purpose: "broken server", background: true, readyPort: PORT }), done],
        [text("observed the failure"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    const calls = conversationsRepository(db).listToolCallsForTask("t");
    const background = calls.find((c: any) => c.toolName === "run_command");
    // Either surfaced as a failed tool call or a completed one carrying the
    // failure status — never a silent "running" claim for a dead process.
    const result = JSON.parse(background!.resultJson!);
    const claimedStatus = result.status ?? result.error;
    expect(String(claimedStatus)).not.toBe("running");
  }, 60_000);
});
