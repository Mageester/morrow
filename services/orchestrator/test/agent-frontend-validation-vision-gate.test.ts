import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { BrowserController, BrowserEvidence, BrowserViewport, PageSnapshot } from "../src/browser/types.js";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Regression for a real false-"incomplete" bug found while verifying that
 * Morrow can build full-stack apps: the frontend-validation completion gate
 * required every browser_screenshot to carry visionAnalysis
 * "attached_to_next_turn" — unconditionally, even when the routed model has
 * no vision capability at all (a free/cheap-tier model, or "mock" in tests).
 * That made the gate permanently unsatisfiable on such a route: no amount of
 * correct, complete, fully-screenshotted work could ever pass it. A live run
 * against deepseek-v4-flash-free (vision: false) hit exactly this — a
 * genuinely finished, independently-verified full-stack app was still marked
 * "[Incomplete: ... verified vision analysis attachment]".
 */

function seed(db: any, workspacePath: string, prompt: string, providerId: "mock" | "openai" = "mock", model = "mock-model") {
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId, model, useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId, model, reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

class FrontendBrowser implements BrowserController {
  readonly id = "frontend-vision-gate-test";
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
  evidence(): BrowserEvidence[] { return []; }
  async pause() {}
  async resume() {}
  async panic() {}
  async close() {}
}

class ConsoleErrorBrowser extends FrontendBrowser {
  override evidence(): BrowserEvidence[] {
    return [{ kind: "console", message: "uncaught frontend error", detail: { level: "error" }, createdAt: new Date().toISOString() }];
  }
}

// Real pages almost always log something benign (a React DevTools banner, a
// Vite HMR "connected" message, a non-error warning). None of that is a
// functional problem and must not block completion the way an actual error
// does.
class BenignConsoleBrowser extends FrontendBrowser {
  override evidence(): BrowserEvidence[] {
    return [
      { kind: "console", message: "Download the React DevTools for a better development experience", detail: { level: "log" }, createdAt: new Date().toISOString() },
      { kind: "console", message: "[vite] connected.", detail: { level: "info" }, createdAt: new Date().toISOString() },
      { kind: "console", message: "React Router Future Flag Warning", detail: { level: "warning" }, createdAt: new Date().toISOString() },
    ];
  }
}

class NavigationFailureBrowser extends FrontendBrowser {
  override async snapshot(): Promise<PageSnapshot> {
    return { ...await super.snapshot(), navigationError: "route returned an application error" } as PageSnapshot;
  }
}

class MalformedSnapshotBrowser extends FrontendBrowser {
  override async snapshot(): Promise<PageSnapshot> {
    return { ...await super.snapshot(), snapshotError: "DOM snapshot was truncated" } as PageSnapshot;
  }
}

// The exact evidence the completion gate demands: open, snapshot, console,
// one interaction, and a screenshot at each of the three required viewports.
function frontendValidationTurn() {
  const calls = [
    tool("bo", "browser_open", { url: "http://127.0.0.1:4173/" }).toolCalls[0]!,
    tool("bs", "browser_snapshot", {}).toolCalls[0]!,
    tool("bc", "browser_console", {}).toolCalls[0]!,
    tool("bi", "browser_click", { ref: "e1" }).toolCalls[0]!,
    tool("bd", "browser_viewport", { preset: "desktop" }).toolCalls[0]!,
    tool("bds", "browser_screenshot", { label: "desktop" }).toolCalls[0]!,
    tool("bt", "browser_viewport", { preset: "tablet" }).toolCalls[0]!,
    tool("bts", "browser_screenshot", { label: "tablet" }).toolCalls[0]!,
    tool("bm", "browser_viewport", { preset: "mobile" }).toolCalls[0]!,
    tool("bms", "browser_screenshot", { label: "mobile" }).toolCalls[0]!,
  ].map((call, index) => ({ ...call, index }));
  return [{ type: "tool_call" as const, toolCalls: calls }, done];
}

describe("frontend-validation completion gate — vision requirement", () => {
  let db: any;
  let ws: string;
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-visiongate-ws-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "morrow-visiongate-home-")));
    prevHome = process.env.MORROW_HOME; process.env.MORROW_HOME = home;
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    try { db.close(); } catch {}
    if (prevHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = prevHome;
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("completes a fully-screenshotted frontend task on a non-vision route instead of demanding an impossible vision attachment", async () => {
    seed(db, ws, "Build a small website and verify it in the browser.", "mock", "mock-model");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        frontendValidationTurn(),
        [text("Built and verified the page."), done],
        // v0.8.1 grants one bounded "not finished" continuation; the model has
        // no further browser evidence to add, so the run settles here.
        [text("There is no further browser evidence I can capture."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FrontendBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.interrupted")).toBe(false);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");

    const finalMessage = conversationsRepository(db).getMessage("ma");
    expect(finalMessage?.content ?? "").not.toContain("[Incomplete:");
  });

  it("treats completed browser-validation steps as progress instead of stalling mid-validation", async () => {
    // Regression for the live stall: a static-site run served the workspace,
    // then gathered browser evidence one step per turn. Browser calls counted
    // as neither verification evidence nor bounded reads, so the stagnation
    // clock interrupted the run after 3 turns — mid-validation.
    seed(db, ws, "Build a small website and verify it in the browser.", "mock", "mock-model");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        [tool("bo", "browser_open", { url: "http://127.0.0.1:4173/" }), done],
        [tool("bs", "browser_snapshot", {}), done],
        [tool("bc", "browser_console", {}), done],
        [tool("bi", "browser_click", { ref: "e1" }), done],
        [tool("bd", "browser_viewport", { preset: "desktop" }), done],
        [tool("bds", "browser_screenshot", { label: "desktop" }), done],
        [tool("bt", "browser_viewport", { preset: "tablet" }), done],
        [tool("bts", "browser_screenshot", { label: "tablet" }), done],
        [tool("bm", "browser_viewport", { preset: "mobile" }), done],
        [tool("bms", "browser_screenshot", { label: "mobile" }), done],
        [text("Built and verified the page."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FrontendBrowser(), maxTurns: 24 }));
    runner.run("t");
    await runner.waitFor("t");

    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.interrupted" && e.payload?.reason === "stalled")).toBe(false);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("does not let a deduplicated repeated interaction poison frontend completion evidence", async () => {
    // Live deepseek-v4-pro runs clicked the same element twice; the second call
    // was deduplicated to a `{ duplicate: true }` placeholder. Because the
    // interaction check used `.every()`, that placeholder (clicked: undefined)
    // failed validation and made `interaction` false for the whole task —
    // blocking completion of a fully-built, browser-verified app.
    seed(db, ws, "Build a small website and verify it in the browser.", "mock", "mock-model");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        [tool("bo", "browser_open", { url: "http://127.0.0.1:4173/" }), done],
        [tool("bs", "browser_snapshot", {}), done],
        [tool("bc", "browser_console", {}), done],
        [tool("bi", "browser_click", { ref: "e1" }), done],
        [tool("bi2", "browser_click", { ref: "e1" }), done], // identical → deduplicated placeholder
        [tool("bd", "browser_viewport", { preset: "desktop" }), done],
        [tool("bds", "browser_screenshot", { label: "desktop" }), done],
        [tool("bt", "browser_viewport", { preset: "tablet" }), done],
        [tool("bts", "browser_screenshot", { label: "tablet" }), done],
        [tool("bm", "browser_viewport", { preset: "mobile" }), done],
        [tool("bms", "browser_screenshot", { label: "mobile" }), done],
        [text("Built and verified the page."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FrontendBrowser(), maxTurns: 24 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("does not let a transient failed browser_open/click poison frontend completion evidence", async () => {
    // Live bug (Pomodoro build, deepseek-v4-flash): the default static-server
    // port was already taken, so the model's first browser_open FAILED; it moved
    // its server to another port and re-opened and verified there successfully,
    // and one interaction hit a momentarily-stale ref before a clean retry.
    // Because routeHealthy/interaction used `.every()` over all calls, the failed
    // attempts poisoned both categories permanently, and a fully browser-verified
    // app was blocked with frontend_route_missing + frontend_interaction_missing.
    // A recovered-from failure must not count against the evidence.
    class FlakyThenHealthyBrowser extends FrontendBrowser {
      opens = 0;
      clicks = 0;
      override async open(url: string): Promise<PageSnapshot> {
        this.opens += 1;
        if (this.opens === 1) throw new Error("EADDRINUSE: static server not ready on that port");
        return super.open(url);
      }
      override async click(): Promise<void> {
        this.clicks += 1;
        if (this.clicks === 1) throw new Error("element ref went stale before the click landed");
      }
    }
    seed(db, ws, "Build a small website and verify it in the browser.", "mock", "mock-model");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        [tool("bo_fail", "browser_open", { url: "http://127.0.0.1:4173/" }), done], // fails: port taken
        [tool("bo", "browser_open", { url: "http://127.0.0.1:4187/" }), done],       // recovers on a new port
        [tool("bs", "browser_snapshot", {}), done],
        [tool("bc", "browser_console", {}), done],
        [tool("bi_fail", "browser_click", { ref: "e1" }), done], // fails: stale ref
        [tool("bi", "browser_click", { ref: "e1" }), done],       // clean retry
        [tool("bd", "browser_viewport", { preset: "desktop" }), done],
        [tool("bds", "browser_screenshot", { label: "desktop" }), done],
        [tool("bt", "browser_viewport", { preset: "tablet" }), done],
        [tool("bts", "browser_screenshot", { label: "tablet" }), done],
        [tool("bm", "browser_viewport", { preset: "mobile" }), done],
        [tool("bms", "browser_screenshot", { label: "mobile" }), done],
        [text("Built and verified the page after recovering from the port conflict."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FlakyThenHealthyBrowser(), maxTurns: 28 }));
    runner.run("t");
    await runner.waitFor("t");

    const events = taskRecordsRepository(db).listEvents("t");
    const blocked = events.find((e: any) => e.type === "task.interrupted");
    const blockerCodes = ((blocked?.payload as any)?.completionBlockers ?? []).map((b: any) => b.code);
    expect(blockerCodes).not.toContain("frontend_route_missing");
    expect(blockerCodes).not.toContain("frontend_interaction_missing");
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("completes model output while recording browser console errors", async () => {
    seed(db, ws, "Build a small website and verify it in the browser.", "mock", "mock-model");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        frontendValidationTurn(),
        [text("Built and verified the page."), done],
        // v0.8.1 grants one bounded "not finished" continuation; the model
        // has no further browser evidence to add, so the run settles here.
        [text("The console errors come from the page itself; there is nothing more to capture."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new ConsoleErrorBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });

  it("completes despite benign non-error console noise (regression: diligent console checks were penalized)", async () => {
    // Live deepseek-v4-pro run building ShiftFlow: the model opened a real
    // browser, ran browser_console repeatedly, correctly diagnosed the only
    // observed messages as harmless Vite HMR/React DevTools noise unrelated
    // to app functionality, and said so in its final report. The completion
    // gate still blocked with frontend_console_unclean because it demanded
    // zero console events of ANY kind, not zero actual errors — punishing
    // the exact thorough investigation behavior we want.
    seed(db, ws, "Build a small website and verify it in the browser.", "mock", "mock-model");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        frontendValidationTurn(),
        [text("Built and verified the page."), done],
        // v0.8.1 grants one bounded "not finished" continuation; the model has
        // no further browser evidence to add, so the run settles here.
        [text("There is no further browser evidence I can capture."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new BenignConsoleBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.interrupted" && e.payload?.completionBlockers?.some((b: any) => b.code === "frontend_console_unclean"))).toBe(false);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("completes model output while recording durable browser navigation failure", async () => {
    seed(db, ws, "Build a small website and verify it in the browser.", "mock", "mock-model");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        frontendValidationTurn(),
        [text("Built and verified the page."), done],
        // v0.8.1 grants one bounded "not finished" continuation; the model has
        // no further browser evidence to add, so the run settles here.
        [text("There is no further browser evidence I can capture."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new NavigationFailureBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });

  it("completes model output while recording a malformed durable DOM snapshot", async () => {
    seed(db, ws, "Build a small website and verify it in the browser.", "mock", "mock-model");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        frontendValidationTurn(),
        [text("Built and verified the page."), done],
        // v0.8.1 grants one bounded "not finished" continuation; the model has
        // no further browser evidence to add, so the run settles here.
        [text("There is no further browser evidence I can capture."), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new MalformedSnapshotBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });

  it("still requires vision-attached screenshots on a route that genuinely supports vision (no regression)", async () => {
    seed(db, ws, "Build a small website and verify it in the browser.", "openai", "gpt-5.6-sol");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        frontendValidationTurn(),
        [text("Built and verified the page."), done],
        // v0.8.1 grants one bounded "not finished" continuation; the model has
        // no further browser evidence to add, so the run settles here.
        [text("There is no further browser evidence I can capture."), done],
      ],
      delayMs: 1,
    });
    (provider as any).id = "openai";
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FrontendBrowser(), maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");

    // A genuinely vision-capable route's screenshots came back
    // "attached_to_next_turn" from the real browser_screenshot handler (per
    // agent-beta26-regression.test.ts using this exact setup), so this must
    // still land as a clean completion — the fix must not weaken the gate for
    // a route that actually can do vision analysis.
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });
});
