import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { processesRepository } from "../src/repositories/processes.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask, isForwardLookingNarration } from "../src/execution/agent.js";
import type { BrowserController, BrowserViewport, PageSnapshot } from "../src/browser/types.js";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Hermes-style loop regression: any assistant turn containing tool calls is
 * provisional because the model has not yet seen those tool results.
 * Tool-bearing turns remain provisional even when they contain click,
 * snapshot, console, screenshot, or browser_open calls; the model must see
 * their results before providing the canonical final.
 * browser_open is especially exploratory: the model writes its text BEFORE
 * knowing what the navigation will show. A turn saying "Final check: reload
 * the page to confirm clean route health after all interactions." plus a
 * browser_open call must not be accepted as the canonical final answer merely
 * because the frontend evidence contract was already otherwise satisfied —
 * the model never got a chance to react to what the reload actually revealed.
 * A later tool-free provider turn owns the canonical final.
 */

function seed(db: any, workspacePath: string, prompt: string) {
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

class FrontendBrowser implements BrowserController {
  readonly id = "fastpath-navigation-test";
  private viewport = { width: 1280, height: 720 };
  private url = "about:blank";
  async start() {}
  async open(url: string): Promise<PageSnapshot> { this.url = url; return this.snapshot(); }
  async snapshot(): Promise<PageSnapshot> { return { url: this.url, title: "Site", viewport: this.viewport, refs: [{ ref: "e1", role: "button", name: "Inspect" }], text: "Site", injectionFindings: 0 }; }
  async setViewport(value: BrowserViewport) { this.viewport = { width: value.width, height: value.height }; }
  async click() {}
  async type() {}
  async key() {}
  async select() {}
  async upload() {}
  async download() { return { path: "download", filename: "download" }; }
  async setDialogHandler() {}
  async screenshot() { return Buffer.from("screenshot"); }
  evidence() { return []; }
  async pause() {}
  async resume() {}
  async panic() {}
  async close() {}
}

describe("Hermes-style tool-turn finality", () => {
  let db: any;
  let ws: string;
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-fastpath-ws-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "morrow-fastpath-home-")));
    prevHome = process.env.MORROW_HOME; process.env.MORROW_HOME = home;
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    try { db.close(); } catch {}
    if (prevHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = prevHome;
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("does not treat pre-navigation narration as the final answer once a browser_open call is pending", async () => {
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body><button id=e1>Inspect</button></body></html>\n" }), done],
        // One turn establishes every category of frontend completion evidence.
        [
          {
            type: "tool_call" as const,
            toolCalls: [
              tool("bo1", "browser_open", { url: "http://127.0.0.1:4173/" }).toolCalls[0]!,
              tool("bs", "browser_snapshot", {}).toolCalls[0]!,
              tool("bc", "browser_console", {}).toolCalls[0]!,
              tool("bi", "browser_click", { ref: "e1" }).toolCalls[0]!,
              tool("bd", "browser_viewport", { preset: "desktop" }).toolCalls[0]!,
              tool("bds", "browser_screenshot", { label: "desktop" }).toolCalls[0]!,
              tool("bt", "browser_viewport", { preset: "tablet" }).toolCalls[0]!,
              tool("bts", "browser_screenshot", { label: "tablet" }).toolCalls[0]!,
              tool("bm", "browser_viewport", { preset: "mobile" }).toolCalls[0]!,
              tool("bms", "browser_screenshot", { label: "mobile" }).toolCalls[0]!,
            ].map((call, index) => ({ ...call, index })),
          },
          done,
        ],
        // The contract is now already satisfiable from prior evidence. This
        // turn's text narrates an UPCOMING reload, not a completed result —
        // it must not be accepted as the canonical answer just because
        // browser_open is present and completed in the same turn.
        [text("Final check: reload the page to confirm clean route health after all interactions."), tool("bo2", "browser_open", { url: "http://127.0.0.1:4173/" }), done],
        // Only after seeing the reload succeed does the model give a genuine
        // closing report with no further tool calls.
        [text("Verified: the reload showed a clean, working page. Built and verified the page."), done],
      ],
      delayMs: 1,
    });
    seed(db, ws, "Build a small website and verify it in the browser.");
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FrontendBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const finalMessage = conversationsRepository(db).getMessage("ma");
    expect(finalMessage?.content ?? "").not.toContain("Final check: reload the page");
    expect(finalMessage?.content ?? "").toContain("Verified: the reload showed a clean, working page.");
  });

  it("does not accept forward-looking prose adjacent to tool calls as the final", async () => {
    // A model can emit narration before its tool calls. The tool results are
    // not observations available to that same assistant turn, so execution
    // must continue to the next provider turn without injecting a controller
    // summary request.
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body><button id=e1>Inspect</button></body></html>\n" }), done],
        // Establish every category of frontend completion evidence.
        [
          {
            type: "tool_call" as const,
            toolCalls: [
              tool("bo1", "browser_open", { url: "http://127.0.0.1:4173/" }).toolCalls[0]!,
              tool("bs", "browser_snapshot", {}).toolCalls[0]!,
              tool("bc", "browser_console", {}).toolCalls[0]!,
              tool("bi", "browser_click", { ref: "e1" }).toolCalls[0]!,
              tool("bd", "browser_viewport", { preset: "desktop" }).toolCalls[0]!,
              tool("bds", "browser_screenshot", { label: "desktop" }).toolCalls[0]!,
              tool("bt", "browser_viewport", { preset: "tablet" }).toolCalls[0]!,
              tool("bts", "browser_screenshot", { label: "tablet" }).toolCalls[0]!,
              tool("bm", "browser_viewport", { preset: "mobile" }).toolCalls[0]!,
              tool("bms", "browser_screenshot", { label: "mobile" }).toolCalls[0]!,
            ].map((call, index) => ({ ...call, index })),
          },
          done,
        ],
        // Forward-looking narration paired with same-turn evidence tools. The
        // contract is already satisfiable, but this turn is not final because
        // the model has not yet seen these tool results.
        [text("All three viewports captured. Final check: confirm the controls still render correctly on mobile and grab final console evidence."),
          {
            type: "tool_call" as const,
            toolCalls: [
              tool("fs", "browser_snapshot", {}).toolCalls[0]!,
              tool("fc", "browser_console", {}).toolCalls[0]!,
            ].map((call, index) => ({ ...call, index })),
          },
          done],
        // The subsequent tool-free model turn is the only canonical final.
        [text("Built the Pomodoro timer (index.html): a 25:00 countdown with working Start, Pause, and Reset controls, verified in the browser with a clean console across desktop, tablet, and mobile."), done],
      ],
      delayMs: 1,
    });
    seed(db, ws, "Build a small website and verify it in the browser.");
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FrontendBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(provider.requests).toHaveLength(4);
    const finalMessage = conversationsRepository(db).getMessage("ma");
    expect(finalMessage?.content ?? "").toContain("Built the Pomodoro timer");
    expect(finalMessage?.content ?? "").not.toContain("Final check: confirm the controls");
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.content).toContain("Built the Pomodoro timer");
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.progress_warning" && e.payload?.reason === "final_summary_requested")).toBe(false);
  });

  it("does not request a tool-free final summary while explicitly required process cleanup remains", async () => {
    seed(db, ws, "Build a small website, verify it in the browser, then stop the background process before finishing.");
    const supervisor = new ProcessSupervisor(processesRepository(db), join(home, "process-logs"));
    const started = await supervisor.start({
      projectId: "p",
      taskId: "t",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: ws,
    });
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body><button id=e1>Inspect</button></body></html>\n" }), done],
        [{
          type: "tool_call" as const,
          toolCalls: [
            tool("bo1", "browser_open", { url: "http://127.0.0.1:4173/" }).toolCalls[0]!,
            tool("bs", "browser_snapshot", {}).toolCalls[0]!,
            tool("bc", "browser_console", {}).toolCalls[0]!,
            tool("bi", "browser_click", { ref: "e1" }).toolCalls[0]!,
            tool("bd", "browser_viewport", { preset: "desktop" }).toolCalls[0]!,
            tool("bds", "browser_screenshot", { label: "desktop" }).toolCalls[0]!,
            tool("bt", "browser_viewport", { preset: "tablet" }).toolCalls[0]!,
            tool("bts", "browser_screenshot", { label: "tablet" }).toolCalls[0]!,
            tool("bm", "browser_viewport", { preset: "mobile" }).toolCalls[0]!,
            tool("bms", "browser_screenshot", { label: "mobile" }).toolCalls[0]!,
          ].map((call, index) => ({ ...call, index })),
        }, done],
        [text("All three screenshots captured. Final DOM and console check:"), {
          type: "tool_call" as const,
          toolCalls: [
            tool("fs", "browser_snapshot", {}).toolCalls[0]!,
            tool("fc", "browser_console", {}).toolCalls[0]!,
          ].map((call, index) => ({ ...call, index })),
        }, done],
        [tool("stop", "stop_process", { processId: started.id, force: true }), done],
        [text("Built and browser-verified the website, then stopped its background server."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, browserFactory: () => new FrontendBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(processesRepository(db).get(started.id)?.status).not.toBe("running");
    expect(conversationsRepository(db).listToolCallsForTask("t").some((call) => call.id === "stop" && call.status === "completed")).toBe(true);
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((event: any) => event.type === "task.progress_warning" && event.payload?.reason === "final_summary_requested")).toBe(false);
  });

  it("keeps working until the process the user asked to stop is actually stopped", async () => {
    seed(db, ws, "Create the requested file, then stop the background process before finishing.");
    const supervisor = new ProcessSupervisor(processesRepository(db), join(home, "process-logs"));
    const started = await supervisor.start({
      projectId: "p",
      taskId: "t",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: ws,
    });
    const provider = new MockProvider({
      chunks: [
        [tool("create", "create_file", { path: "artifact.txt", content: "delivered\n" }), done],
        [text("The file is ready, but the background process is still running."), done],
        [tool("stop", "stop_process", { processId: started.id, force: true }), done],
        [text("Created the requested file and stopped the task-owned background process."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 8 }));

    try {
      runner.run("t");
      await runner.waitFor("t");

      // The user asked for the process to be stopped, so a model that narrates
      // "it is still running" and stops has not finished. v0.8.1 continues and
      // the cleanup the model already knew how to do actually happens.
      expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
      expect(processesRepository(db).get(started.id)?.status).not.toBe("running");
      const calls = conversationsRepository(db).listToolCallsForTask("t");
      expect(calls.map((call) => call.id)).toEqual(["create", "stop"]);
      expect(taskRecordsRepository(db).listEvents("t").some((event: any) =>
        event.payload?.reason === "unfinished_work_continuation"
        && event.payload?.blockers?.includes("background_process_running"))).toBe(true);
      expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({
        completion: { complete: true },
      });
    } finally {
      await supervisor.terminate(started.id, { force: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  it("completes with an honest cleanup blocker when the model leaves the process running", async () => {
    seed(db, ws, "Create the requested file, then stop the background process before finishing.");
    const supervisor = new ProcessSupervisor(processesRepository(db), join(home, "process-logs"));
    const started = await supervisor.start({
      projectId: "p",
      taskId: "t",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: ws,
    });
    const provider = new MockProvider({
      chunks: [
        [tool("create", "create_file", { path: "artifact.txt", content: "delivered\n" }), done],
        [text("The file is ready, but the background process is still running."), done],
        // The continuation is granted, and the model still declines to act, so
        // the run settles with the honest blocker rather than looping.
        [text("The file is ready, but the background process is still running."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 8 }));

    try {
      runner.run("t");
      await runner.waitFor("t");

      expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
      expect(processesRepository(db).get(started.id)?.status).toBe("running");
      expect(provider.requests).toHaveLength(3);
      const events = taskRecordsRepository(db).listEvents("t");
      expect(events.filter((event: any) => event.payload?.reason === "completion_contract_recovery")).toHaveLength(0);
      expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({
        completion: { complete: false, blockers: expect.arrayContaining([expect.objectContaining({ code: "background_process_running" })]) },
      });
    } finally {
      await supervisor.terminate(started.id, { force: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });
});

describe("isForwardLookingNarration", () => {
  it("flags mid-work narration that announces an upcoming action", () => {
    for (const text of [
      "All three viewports captured. Final check: confirm the controls still render correctly on mobile and grab final console evidence.",
      "Now let me start a static server for pomodoro/ and open it in the browser for validation.",
      "Screenshot captured. Continuing with tablet and mobile.",
      "Reset works. Now I'll verify the responsive layout.",
      "Here is the plan:",
      "",
    ]) {
      expect(isForwardLookingNarration(text)).toBe(true);
    }
  });

  it("does not flag a genuine concluding report", () => {
    for (const text of [
      "Built the Pomodoro timer (index.html): a 25:00 countdown with working Start, Pause, and Reset controls, verified in the browser with a clean console.",
      "Verified: the reload showed a clean, working page. Built and verified the page.",
      "The responsive frontend passed DOM, console, interaction, and visual checks.",
      "Done — all three controls work and the console is clean.",
    ]) {
      expect(isForwardLookingNarration(text)).toBe(false);
    }
  });
});
