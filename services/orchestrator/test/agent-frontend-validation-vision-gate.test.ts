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

  it("still requires vision-attached screenshots on a route that genuinely supports vision (no regression)", async () => {
    seed(db, ws, "Build a small website and verify it in the browser.", "openai", "gpt-5.6-sol");
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "index.html", content: "<!doctype html><html><body>Hi</body></html>\n" }), done],
        frontendValidationTurn(),
        [text("Built and verified the page."), done],
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
