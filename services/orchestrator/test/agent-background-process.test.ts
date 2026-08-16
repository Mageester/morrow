import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { processesRepository } from "../src/repositories/processes.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { observeProcessOutputProgress, seedProcessObservationStatus, type ProcessObservationState } from "../src/execution/process-observation-progress.js";
import type { BrowserController } from "../src/browser/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Full-stack apps need a long-running dev server, not a one-shot command.
 * These tests prove the agent can start one in the background (without
 * run_command's blocking wait-for-exit), poll its output, and stop it — the
 * capability gap that made "build me a full-stack app" fail every time
 * (see agent.ts's run_command background:true and the new
 * read_process_output/stop_process tools).
 */

function seed(db: any, workspacePath: string, mode: "agent" | "read-only" = "agent", prompt = "go") {
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode, autoApprove: true },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const rawTool = (id: string, name: string, argumentsJson: string) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: argumentsJson } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

// Stays alive until killed; prints "ready" immediately so tests can poll for it.
const LONG_RUNNING_SCRIPT = "console.log('ready'); setInterval(() => {}, 1000);";

describe("agent background processes (full-stack dev-server capability)", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "morrow-bgproc-")); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("starts a long-running command in the background instead of blocking until it exits", async () => {
    seed(db, ws);
    const logsDir = mkdtempSync(join(tmpdir(), "morrow-bgproc-logs0-"));
    const supervisor = new ProcessSupervisor(processesRepository(db), logsDir);
    const provider = new MockProvider({
      chunks: [
        [tool("x1", "run_command", { executable: "node", args: ["-e", LONG_RUNNING_SCRIPT], purpose: "start dev server", background: true }), done],
        [text("started"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 4 }));

    const startedAt = Date.now();
    runner.run("t");
    await runner.waitFor("t");
    const elapsedMs = Date.now() - startedAt;

    // A blocking run would still be waiting on the never-exiting process; a
    // background start must return almost immediately.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");

    const call = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "run_command")!;
    const result = JSON.parse(call.resultJson!);
    expect(result.processId).toBeTruthy();
    expect(result.status).toBe("running");

    const record = processesRepository(db).get(result.processId);
    expect(record?.status).toBe("running");

    // Clean up the real OS process this test actually spawned, and wait for
    // the exit event to settle before the DB closes (afterEach) — the
    // supervisor's own exit handler writes to it asynchronously.
    await supervisor.terminate(result.processId, { force: true });
    await new Promise((r) => setTimeout(r, 300));
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("lets the agent poll output and stop what it started, sharing one supervisor with the rest of the orchestrator", async () => {
    seed(db, ws);
    const logsDir = mkdtempSync(join(tmpdir(), "morrow-bgproc-logs-"));
    // The same ProcessSupervisor instance production shares between the REST
    // process routes and the agent (see index.ts) — injected here so the
    // process this test pre-starts is one the agent's own stop_process call can
    // actually see and terminate (terminate() needs the live in-process handle,
    // not just the DB row).
    const supervisor = new ProcessSupervisor(processesRepository(db), logsDir);
    const started = await supervisor.start({ projectId: "p", command: "node", args: ["-e", LONG_RUNNING_SCRIPT], cwd: ws });
    // Give it a beat to actually write "ready" to the captured log.
    await new Promise((r) => setTimeout(r, 300));

    const provider = new MockProvider({
      chunks: [
        [tool("x1", "read_process_output", { processId: started.id }), done],
        [tool("x2", "stop_process", { processId: started.id, force: true }), done],
        [text("verified and stopped"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const calls = conversationsRepository(db).listToolCallsForTask("t");

    const readCall = calls.find((c: any) => c.toolName === "read_process_output")!;
    const readResult = JSON.parse(readCall.resultJson!);
    expect(readResult.data).toContain("ready");

    const stopCall = calls.find((c: any) => c.toolName === "stop_process")!;
    const stopResult = JSON.parse(stopCall.resultJson!);
    expect(stopResult.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    const record = processesRepository(db).get(started.id);
    expect(record?.status).not.toBe("running");
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("continues to browser verification and cleanup when a boundary poll reveals new task-owned output", async () => {
    const prompt = "Create a local page, start a background server, inspect its output, open it in the browser, and stop the background server before completing.";
    seed(db, ws, "agent", prompt);

    // These successful searches consume the bounded post-delivery read
    // allowance without adding durable evidence, so the provider cannot
    // receive mutation credit while this regression drives the ladder.

    const processRepo = processesRepository(db);
    const serverOutput = "Flagship Task Board listening on http://127.0.0.1:50065/\n";
    let failNextProcessRead = true;
    const supervisor = {
      start: async (options: any) => processRepo.create({
        id: "owned-process",
        projectId: options.projectId,
        taskId: options.taskId,
        agentId: options.agentId,
        command: options.command,
        args: options.args ?? [],
        cwd: options.cwd,
        mode: "pipe",
        pid: null,
        runId: "deterministic-process-run",
      }),
      readOutput: () => {
        if (failNextProcessRead) {
          failNextProcessRead = false;
          throw new Error("deterministic process read failure");
        }
        return {
          data: serverOutput,
          nextOffset: Buffer.byteLength(serverOutput, "utf8"),
          eof: false,
          truncated: false,
        };
      },
      terminate: async (id: string) => {
        processRepo.finish(id, "cancelled", null, "deterministic test cleanup");
        return { ok: true };
      },
    } as any;
    const browser = {
      id: "deterministic-browser",
      open: async (url: string) => ({
        url,
        title: "Flagship Task Board",
        viewport: { width: 1280, height: 720 },
        refs: [],
        text: "Flagship Task Board",
        injectionFindings: 0,
      }),
      close: async () => undefined,
    } as unknown as BrowserController;

    const chunks: any[] = [
      [tool("deliver", "create_file", { path: "index.html", content: "<main>Flagship Task Board</main>\n" }), done],
      [tool("start", "run_command", { executable: "node", args: ["server.mjs"], purpose: "start the background server", background: true }), done],
    ];
    for (let index = 0; index < 8; index++) {
      chunks.push([tool(`observed-${index}`, "search_text", { query: `no-match-${index}` }), done]);
    }
    // Two complete no-progress ladders put the next turn at the exact
    // post-recovery stagnation boundary retained from the live failure.
    for (let index = 0; index < 3; index++) {
      chunks.push([tool(`diagnosis-${index}`, "read_file", { path: `missing-diagnosis-${index}.txt` }), done]);
    }
    chunks.push([tool("failed-process-poll", "read_process_output", { processId: "owned-process", stream: "stdout", offset: 0 }), done]);
    chunks.push([tool("stagnant-search", "search_text", { query: "no-match-after-allowance" }), done]);
    chunks.push([tool("recovery-0", "read_file", { path: "missing-recovery-0.txt" }), done]);
    for (let index = 0; index < 2; index++) {
      chunks.push([tool(`boundary-${index}`, "read_file", { path: `missing-boundary-${index}.txt` }), done]);
    }
    chunks.push([tool("server-output", "read_process_output", { processId: "owned-process", stream: "stdout", offset: 0 }), done]);
    chunks.push([{
      type: "tool_call",
      toolCalls: [
        { ...tool("browser", "browser_open", { url: "http://127.0.0.1:50065/" }).toolCalls[0]!, index: 0 },
        { ...tool("cleanup", "stop_process", { processId: "owned-process", force: true }).toolCalls[0]!, index: 1 },
      ],
    }, done]);
    chunks.push([text("The page was opened and the background server was stopped."), done]);

    const provider = new MockProvider({ chunks });
    await executeAgentChatTask({ db, taskId: "t", provider, supervisor, browserFactory: () => browser, maxTurns: 32 });

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(processRepo.get("owned-process")).toMatchObject({ taskId: "t", status: "cancelled" });
    const calls = conversationsRepository(db).listToolCallsForTask("t");
    expect(calls.map((call: any) => call.toolName)).toEqual(expect.arrayContaining(["browser_open", "stop_process"]));
    expect(calls.find((call: any) => call.id === "failed-process-poll")?.status).toBe("failed");
    expect(calls.find((call: any) => call.id === "server-output")?.status).toBe("completed");
    expect(provider.requests).toHaveLength(21);
  });

  it("does not let an infinite process offset terminate useful work", async () => {
    const prompt = "Create a local page, start a background server, inspect its output, open it in the browser, and stop the background server before completing.";
    seed(db, ws, "agent", prompt);

    const processRepo = processesRepository(db);
    const serverOutput = "Flagship Task Board listening on http://127.0.0.1:50065/\n";
    const outputLength = Buffer.byteLength(serverOutput, "utf8");
    const readOffsets: number[] = [];
    const supervisor = {
      start: async (options: any) => processRepo.create({
        id: "owned-process",
        projectId: options.projectId,
        taskId: options.taskId,
        agentId: options.agentId,
        command: options.command,
        args: options.args ?? [],
        cwd: options.cwd,
        mode: "pipe",
        pid: null,
        runId: "deterministic-process-run",
      }),
      readOutput: (_processId: string, _stream: "stdout" | "stderr", offset: number) => {
        readOffsets.push(offset);
        // Mirror ProcessSupervisor's EOF clamp: an infinite offset reads an
        // empty slice but reports the existing log's absolute end offset.
        return offset === Number.POSITIVE_INFINITY
          ? { data: "", nextOffset: outputLength, eof: false, truncated: false }
          : { data: serverOutput, nextOffset: outputLength, eof: false, truncated: false };
      },
      terminate: async (id: string) => {
        processRepo.finish(id, "cancelled", null, "deterministic test cleanup");
        return { ok: true };
      },
    } as any;

    const chunks: any[] = [
      [tool("deliver", "create_file", { path: "index.html", content: "<main>Flagship Task Board</main>\n" }), done],
      [tool("start", "run_command", { executable: "node", args: ["server.mjs"], purpose: "start the background server", background: true }), done],
      [tool("initial-output", "read_process_output", { processId: "owned-process", stream: "stdout", offset: 0 }), done],
    ];
    for (let index = 0; index < 8; index++) {
      chunks.push([tool(`observed-${index}`, "search_text", { query: `no-match-${index}` }), done]);
    }
    for (let index = 0; index < 3; index++) {
      chunks.push([tool(`diagnosis-${index}`, "read_file", { path: `missing-diagnosis-${index}.txt` }), done]);
    }
    chunks.push([tool("failed-process-poll", "read_process_output", { processId: "owned-process", stream: "stdout", offset: 0 }), done]);
    chunks.push([tool("stagnant-search", "search_text", { query: "no-match-after-allowance" }), done]);
    chunks.push([tool("recovery-0", "read_file", { path: "missing-recovery-0.txt" }), done]);
    for (let index = 0; index < 2; index++) {
      chunks.push([tool(`boundary-${index}`, "read_file", { path: `missing-boundary-${index}.txt` }), done]);
    }
    chunks.push([rawTool(
      "infinite-offset",
      "read_process_output",
      '{"processId":"owned-process","stream":"stdout","offset":1e999}',
    ), done]);
    chunks.push([text("The background process remains available after the extended diagnosis."), done]);

    const provider = new MockProvider({ chunks });
    await executeAgentChatTask({ db, taskId: "t", provider, supervisor, maxTurns: 32 });

    // The malformed non-finite offset is normalized at the tool boundary and
    // still executes as an ordinary poll. It must not become a cognitive
    // offset/progress supervisor that cuts off useful work.
    expect(readOffsets).toEqual([0, 0, 0]);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const calls = conversationsRepository(db).listToolCallsForTask("t");
    expect(calls.find((call: any) => call.id === "infinite-offset")?.status).toBe("completed");
    expect(calls.some((call: any) => call.toolName === "stop_process")).toBe(false);
    expect(provider.requests).toHaveLength(21);
    expect(processRepo.get("owned-process")?.status).not.toBe("running");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) =>
      event.payload?.signal === "loop_stalled"
      || event.payload?.signal === "no_progress"
      || event.payload?.signal === "observation_epoch_exhausted"
      || event.payload?.signal === "strategy_change_required"
      || event.payload?.reason === "loop_stalled"
    )).toBe(false);
  });

  it("refuses to read or stop a process belonging to a different project", async () => {
    seed(db, ws);
    const otherWs = mkdtempSync(join(tmpdir(), "morrow-bgproc-other-"));
    const logsDir = mkdtempSync(join(tmpdir(), "morrow-bgproc-logs2-"));
    projectRepository(db).createProject({ id: "other", name: "Other", workspacePath: otherWs, createdAt: new Date().toISOString() });
    const supervisor = new ProcessSupervisor(processesRepository(db), logsDir);
    const started = await supervisor.start({ projectId: "other", command: "node", args: ["-e", LONG_RUNNING_SCRIPT], cwd: otherWs });

    const provider = new MockProvider({
      chunks: [[tool("x1", "read_process_output", { processId: started.id }), done], [text("done"), done]],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    const call = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "read_process_output");
    expect(call?.status).toBe("failed");
    expect(call?.resultJson).toMatch(/not found/i);

    await supervisor.terminate(started.id, { force: true });
    await new Promise((r) => setTimeout(r, 200));
    rmSync(otherWs, { recursive: true, force: true });
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("stops a task-owned background process left running when the task completes, even without explicit cleanup wording in the prompt", async () => {
    // Deliberately the default "go" prompt (seed()'s default) — it contains
    // none of the "stop it before finishing" phrasing that
    // requiresBackgroundProcessCleanup() looks for, reproducing the live gap
    // (flagship-web-v1, 2026-08-09) where a task completed while its dev
    // server kept running because that heuristic never fired.
    seed(db, ws);
    const logsDir = mkdtempSync(join(tmpdir(), "morrow-bgproc-logs3-"));
    const supervisor = new ProcessSupervisor(processesRepository(db), logsDir);
    const provider = new MockProvider({
      chunks: [
        [tool("x1", "run_command", { executable: "node", args: ["-e", LONG_RUNNING_SCRIPT], purpose: "start dev server", background: true }), done],
        [text("started, and the server is verified working"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const call = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "run_command")!;
    const result = JSON.parse(call.resultJson!);

    // The model never called stop_process — the task-completion funnel must
    // terminate the process on its own instead of leaving it orphaned.
    expect(conversationsRepository(db).listToolCallsForTask("t").some((c: any) => c.toolName === "stop_process")).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    const record = processesRepository(db).get(result.processId);
    expect(record?.status).not.toBe("running");
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("denies stop_process outside agent mode, same as run_command", async () => {
    seed(db, ws, "read-only");
    const provider = new MockProvider({
      chunks: [[tool("x1", "stop_process", { processId: "whatever" }), done], [text("done"), done]],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t");
    await runner.waitFor("t");

    const call = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "stop_process");
    expect(call?.status).toBe("failed");
    expect(call?.resultJson).toMatch(/not permitted in read-only mode/);
  });
});

describe("process observation progress", () => {
  const observe = (
    state: ProcessObservationState,
    offset: number,
    nextOffset: number,
    status = "running",
  ) => observeProcessOutputProgress(state, { status, offset, nextOffset });

  it("merges adjacent byte intervals", () => {
    let state = seedProcessObservationStatus(undefined, "running");
    let result = observe(state, 0, 5);
    expect(result.progress).toBe(true);
    result = observe(result.state, 5, 10);
    expect(result.progress).toBe(true);
    expect(result.state.coveredIntervals).toEqual([{ start: 0, end: 10 }]);
  });

  it("does not credit repeated or wholly covered overlap and subrange polls", () => {
    const seeded = seedProcessObservationStatus(undefined, "running");
    const first = observe(seeded, 10, 20);
    expect(first.progress).toBe(true);

    const repeated = observe(first.state, 10, 20);
    expect(repeated.progress).toBe(false);
    const subrange = observe(repeated.state, 12, 18);
    expect(subrange.progress).toBe(false);
    const overlap = observe(subrange.state, 15, 20);
    expect(overlap.progress).toBe(false);
    expect(overlap.state.coveredIntervals).toEqual([{ start: 10, end: 20 }]);

    const overlappingSuffix = observe(overlap.state, 18, 25);
    expect(overlappingSuffix.progress).toBe(true);
    expect(overlappingSuffix.state.coveredIntervals).toEqual([{ start: 10, end: 25 }]);
    const repeatedSuffix = observe(overlappingSuffix.state, 18, 25);
    expect(repeatedSuffix.progress).toBe(false);
  });

  it("credits a gap or new suffix once and normalizes the covered ranges", () => {
    const seeded = seedProcessObservationStatus(undefined, "running");
    const first = observe(seeded, 0, 5);
    const suffix = observe(first.state, 8, 10);
    expect(suffix.progress).toBe(true);
    expect(suffix.state.coveredIntervals).toEqual([
      { start: 0, end: 5 },
      { start: 8, end: 10 },
    ]);

    const gap = observe(suffix.state, 5, 8);
    expect(gap.progress).toBe(true);
    expect(gap.state.coveredIntervals).toEqual([{ start: 0, end: 10 }]);

    const repeated = observe(gap.state, 0, 10);
    expect(repeated.progress).toBe(false);
    const newSuffix = observe(repeated.state, 10, 12);
    expect(newSuffix.progress).toBe(true);
    expect(newSuffix.state.coveredIntervals).toEqual([{ start: 0, end: 12 }]);
  });

  it("uses raw byte intervals, so a UTF-8 split cannot re-credit a repeated slice", () => {
    const seeded = seedProcessObservationStatus(undefined, "running");
    // These are raw byte offsets for the two halves of a four-byte emoji.
    const firstHalf = observe(seeded, 0, 2);
    expect(firstHalf.progress).toBe(true);
    const repeatedFirstHalf = observe(firstHalf.state, 0, 2);
    expect(repeatedFirstHalf.progress).toBe(false);
    const secondHalf = observe(repeatedFirstHalf.state, 2, 4);
    expect(secondHalf.progress).toBe(true);
    expect(secondHalf.state.coveredIntervals).toEqual([{ start: 0, end: 4 }]);
  });

  it("does not credit empty or offset-only polls, while status transitions remain separate", () => {
    const seeded = seedProcessObservationStatus(undefined, "running");
    const empty = observe(seeded, 4, 4);
    expect(empty.progress).toBe(false);
    const backwards = observe(empty.state, 6, 4);
    expect(backwards.progress).toBe(false);
    expect(backwards.state.coveredIntervals).toEqual([]);

    const transitioned = observe(backwards.state, 6, 4, "exited");
    expect(transitioned.progress).toBe(true);
    expect(transitioned.state.coveredIntervals).toEqual([]);
  });

  it("does not create coverage from non-finite raw offsets", () => {
    const seeded = seedProcessObservationStatus(undefined, "running");
    for (const offset of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const result = observe(seeded, offset, 8);
      expect(result.progress).toBe(false);
      expect(result.state.coveredIntervals).toEqual([]);
    }
    for (const nextOffset of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const result = observe(seeded, 0, nextOffset);
      expect(result.progress).toBe(false);
      expect(result.state.coveredIntervals).toEqual([]);
    }
  });
});
