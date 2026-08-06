import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask, isForwardLookingNarration } from "../src/execution/agent.js";
import type { BrowserController, BrowserViewport, PageSnapshot } from "../src/browser/types.js";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Live regression (Pomodoro build, deepseek-v4-flash): the completion "fast
 * path" treats any completed browser-evidence tool call in the current turn
 * as proof that the turn's accompanying text is a trustworthy final answer.
 * That is correct for click/snapshot/console/screenshot, which report on
 * page state the model already saw before writing its narration — but wrong
 * for browser_open, which is exploratory: the model writes its text BEFORE
 * knowing what the navigation will show. A turn saying "Final check: reload
 * the page to confirm clean route health after all interactions." plus a
 * browser_open call was accepted as the canonical final answer purely
 * because the frontend evidence contract was already otherwise satisfied —
 * the model never got a chance to react to what the reload actually
 * revealed, and the task silently "completed" with that throwaway sentence
 * as its entire final report.
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

describe("completion fast path — browser_open exclusion", () => {
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

  it("requests a tool-free summary turn instead of shipping forward-looking narration as the report", async () => {
    // Live bug (Pomodoro build, deepseek-v4-flash): the task completed green
    // but its entire final report was "All three viewports captured. Final
    // check: confirm the controls still render correctly on mobile and grab
    // final console evidence." — forward-looking narration written alongside a
    // browser_snapshot + browser_console pair, accepted by the fast path
    // because those evidence tools satisfied the contract. browser_open is not
    // involved, so the earlier browser_open-only exclusion cannot catch it.
    // The framework must recognize the narration is not a conclusion and spend
    // one directed, tool-free turn getting a real summary.
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
        // Forward-looking narration paired with same-turn evidence tools (NOT
        // browser_open). The contract is already satisfiable, so the fast path
        // would otherwise ship this sentence as the report.
        [text("All three viewports captured. Final check: confirm the controls still render correctly on mobile and grab final console evidence."),
          {
            type: "tool_call" as const,
            toolCalls: [
              tool("fs", "browser_snapshot", {}).toolCalls[0]!,
              tool("fc", "browser_console", {}).toolCalls[0]!,
            ].map((call, index) => ({ ...call, index })),
          },
          done],
        // The directed summary turn: a genuine, tool-free closing report.
        [text("Built the Pomodoro timer (index.html): a 25:00 countdown with working Start, Pause, and Reset controls, verified in the browser with a clean console across desktop, tablet, and mobile."), done],
      ],
      delayMs: 1,
    });
    seed(db, ws, "Build a small website and verify it in the browser.");
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FrontendBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const finalMessage = conversationsRepository(db).getMessage("ma");
    // The throwaway narration must not be the report; the genuine summary must.
    expect(finalMessage?.content ?? "").not.toContain("Final check: confirm the controls");
    expect(finalMessage?.content ?? "").toContain("Built the Pomodoro timer");
    // And the directed-summary turn must have actually been requested.
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.progress_warning" && e.payload?.reason === "final_summary_requested")).toBe(true);
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
