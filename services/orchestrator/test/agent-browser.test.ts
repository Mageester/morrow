import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import type { BrowserController, BrowserEvidence, BrowserViewport, PageSnapshot } from "../src/browser/types.js";
import { openDatabase } from "../src/database.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { ApprovalContinuationRegistry } from "../src/execution/continuation.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "../src/provider/base.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";

const done = { type: "done" as const };
const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});

class CapturingProvider implements AiProvider {
  readonly id = "openai";
  calls: ChatMessage[][] = [];
  private turn = 0;

  async *streamChat(messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
    this.calls.push(messages.map((message) => ({
      ...message,
      ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
    })));
    if (this.turn++ === 0) {
      yield {
        type: "tool_call",
        toolCalls: [
          { ...tool("open", "browser_open", { url: "http://127.0.0.1:4173/" }).toolCalls[0]!, index: 0 },
          { ...tool("viewport", "browser_viewport", { preset: "mobile" }).toolCalls[0]!, index: 1 },
          { ...tool("snapshot", "browser_snapshot", {}).toolCalls[0]!, index: 2 },
          { ...tool("shot", "browser_screenshot", { label: "home-mobile" }).toolCalls[0]!, index: 3 },
        ],
      };
      yield done;
      return;
    }
    yield { type: "text", text: "The rendered page was inspected with visual evidence." };
    yield done;
  }
}

class ScriptedProvider implements AiProvider {
  readonly id: string;
  calls: ChatMessage[][] = [];
  private turn = 0;
  constructor(private readonly turns: ProviderChunk[][], id = "openai") { this.id = id; }
  async *streamChat(messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
    this.calls.push(messages);
    for (const chunk of this.turns[this.turn++] ?? []) yield chunk;
  }
}

class FakeBrowser implements BrowserController {
  readonly id = "fake-browser";
  closed = false;
  viewport = { width: 1280, height: 720 };
  events: BrowserEvidence[] = [];
  private url = "about:blank";
  clicks = 0;
  opens = 0;
  constructor(private readonly elementName = "Save") {}

  async start() {}
  async open(url: string): Promise<PageSnapshot> { this.opens += 1; this.url = url; return this.snapshot(); }
  async snapshot(): Promise<PageSnapshot> {
    return { url: this.url, title: "Morrow app", viewport: this.viewport, refs: [{ ref: "e1", role: "button", name: this.elementName }], text: "Rendered UI", injectionFindings: 0 };
  }
  async setViewport(viewport: BrowserViewport) { this.viewport = { width: viewport.width, height: viewport.height }; }
  async click() { this.clicks += 1; this.events.push({ kind: "console", message: "clicked", detail: { level: "log" }, createdAt: new Date().toISOString() }); }
  async type() {}
  async key() {}
  async select() {}
  async upload() {}
  async download() { return { path: "download.txt", filename: "download.txt" }; }
  async setDialogHandler() {}
  async screenshot() { return Buffer.from("bounded screenshot bytes"); }
  evidence() { return [...this.events]; }
  async pause() {}
  async resume() {}
  async panic() { await this.close(); }
  async close() { this.closed = true; }
}

describe("agent browser and vision bridge", () => {
  let db: ReturnType<typeof openDatabase>;
  let workspace: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-agent-browser-"));
    priorHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = join(workspace, ".morrow-home");
    const now = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: now });
    conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "browser", createdAt: now, updatedAt: now });
    conversationsRepository(db).appendMessage({ id: "u", conversationId: "c", role: "user", content: "Inspect this local page with browser evidence.", createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
    conversationsRepository(db).appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
    taskRoutingRepository(db).upsert({
      taskId: "t", presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", useMemory: false,
      decision: { version: 1, presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
      createdAt: now,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = priorHome;
  });

  it("requires an origin-scoped approval, persists screenshot evidence, and sends only ephemeral image bytes to a verified vision route", async () => {
    const provider = new CapturingProvider();
    const browser = new FakeBrowser();

    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => browser, maxTurns: 4 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(browser.closed).toBe(true);
    expect(browser.viewport).toEqual({ width: 390, height: 844 });
    expect(approvalsRepository(db).listByTask("t")).toMatchObject([{
      status: "approved",
      details: { tool: "browser_session", origin: "http://127.0.0.1:4173", risk: "network-interaction" },
    }]);

    const evidence = taskRecordsRepository(db).listEvidence("t").find((item) => item.metadata.kind === "browser_screenshot");
    expect(evidence?.metadata).toMatchObject({ label: "home-mobile", viewport: { width: 390, height: 844 }, vision: "attached" });
    expect(readFileSync(evidence!.path)).toEqual(Buffer.from("bounded screenshot bytes"));

    const imageMessage = provider.calls[1]!.find((message) => message.images?.length);
    expect(imageMessage).toMatchObject({ role: "user", content: expect.stringMatching(/screenshot evidence/i) });
    expect(imageMessage!.images![0]!.data).toBe(Buffer.from("bounded screenshot bytes").toString("base64"));
    const durableToolResult = conversationsRepository(db).listToolCallsForTask("t").find((call) => call.toolName === "browser_screenshot")!.resultJson!;
    expect(durableToolResult).not.toContain(imageMessage!.images![0]!.data);
  });

  it("completes model output while recording missing responsive frontend evidence", async () => {
    db.prepare("UPDATE conversation_messages SET content=? WHERE id='u'").run("Build a responsive frontend page and verify it.");
    const provider = new ScriptedProvider([
      [tool("write", "create_file", { path: "index.html", content: "<main>hello</main>" }), done],
      [tool("verify", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify frontend" }), done],
      [{ type: "text", text: "The responsive frontend is complete." }, done],
    ]);

    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => new FakeBrowser(), maxTurns: 6 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("a")?.content).toContain("The responsive frontend is complete.");
    expect(taskRecordsRepository(db).listEvents("t").some((event) => event.type === "task.completed")).toBe(true);
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });

  it("completes a frontend change only after the full post-change responsive validation contract passes", async () => {
    db.prepare("UPDATE conversation_messages SET content=? WHERE id='u'").run("Build a responsive frontend page and verify it.");
    const browser = new FakeBrowser();
    const browserCalls = [
      tool("open", "browser_open", { url: "http://127.0.0.1:4173/" }).toolCalls[0]!,
      tool("snapshot", "browser_snapshot", {}).toolCalls[0]!,
      tool("console", "browser_console", {}).toolCalls[0]!,
      tool("click", "browser_click", { ref: "e1" }).toolCalls[0]!,
      tool("desktop", "browser_viewport", { preset: "desktop" }).toolCalls[0]!,
      tool("desktop-shot", "browser_screenshot", { label: "home-desktop" }).toolCalls[0]!,
      tool("tablet", "browser_viewport", { preset: "tablet" }).toolCalls[0]!,
      tool("tablet-shot", "browser_screenshot", { label: "home-tablet" }).toolCalls[0]!,
      tool("mobile", "browser_viewport", { preset: "mobile" }).toolCalls[0]!,
      tool("mobile-shot", "browser_screenshot", { label: "home-mobile" }).toolCalls[0]!,
    ].map((call, index) => ({ ...call, index }));
    const provider = new ScriptedProvider([
      [tool("write", "create_file", { path: "index.html", content: "<button>Save</button>" }), done],
      [tool("verify", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify frontend" }), done],
      [{ type: "tool_call", toolCalls: browserCalls }, done],
      [{ type: "text", text: "The responsive frontend passed DOM, console, interaction, and visual checks." }, done],
    ]);

    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => browser, maxTurns: 8 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(browser.closed).toBe(true);
    const screenshots = taskRecordsRepository(db).listEvidence("t").filter((item) => item.metadata.kind === "browser_screenshot");
    expect(screenshots.map((item) => item.metadata.viewport)).toEqual([
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]);
    expect(screenshots.every((item) => item.metadata.vision === "attached")).toBe(true);
  });

  it("captures a fresh console observation after a state-changing interaction", async () => {
    const browser = new FakeBrowser();
    const calls = [
      tool("open-fresh", "browser_open", { url: "http://127.0.0.1:4173/" }).toolCalls[0]!,
      tool("console-before", "browser_console", {}).toolCalls[0]!,
      tool("click-fresh", "browser_click", { ref: "e1" }).toolCalls[0]!,
      tool("console-after", "browser_console", {}).toolCalls[0]!,
    ].map((call, index) => ({ ...call, index }));
    const provider = new ScriptedProvider([
      [{ type: "tool_call", toolCalls: calls }, done],
      [{ type: "text", text: "Interaction and fresh console evidence were inspected." }, done],
    ]);

    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => browser, maxTurns: 4 });

    const after = conversationsRepository(db).listToolCallsForTask("t").find((item) => item.id === "console-after");
    expect(after?.status).toBe("completed");
    expect(after?.resultJson).toContain("clicked");
    expect(after?.resultJson).not.toContain('"duplicate":true');
  });

  it("executes a repeated click on the same ref instead of deduplicating a toggle button's second press", async () => {
    // Live bug (Pomodoro build, deepseek-v4-flash): a Start/Pause control is
    // the SAME DOM ref clicked twice with opposite intent. The second click
    // (Pause) had an identical tool-call signature to the first (Start), so it
    // was deduplicated into a { duplicate: true } placeholder and never reached
    // the browser — the timer kept running and the model had to notice and
    // retry. A click is a state mutation, not a re-observation: repeating it is
    // a genuine distinct action and must always execute.
    class ToggleBrowser extends FakeBrowser {
      // Faithfully model the toggle: the button's accessible name flips on
      // each press, exactly like the live Start/Pause control.
      override async snapshot(): Promise<PageSnapshot> {
        const name = this.clicks % 2 === 0 ? "Start" : "Pause";
        return { url: "http://127.0.0.1:4173/", title: "Pomodoro", viewport: this.viewport, refs: [{ ref: "e1", role: "button", name }], text: "Timer", injectionFindings: 0 };
      }
    }
    const browser = new ToggleBrowser();
    const provider = new ScriptedProvider([
      [{ type: "tool_call", toolCalls: [
        { ...tool("open", "browser_open", { url: "http://127.0.0.1:4173/" }).toolCalls[0]!, index: 0 },
        { ...tool("start", "browser_click", { ref: "e1" }).toolCalls[0]!, index: 1 },
        { ...tool("pause", "browser_click", { ref: "e1" }).toolCalls[0]!, index: 2 },
      ] }, done],
      [{ type: "text", text: "Started then paused the timer." }, done],
    ]);

    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => browser, maxTurns: 4 });

    // Ground truth: the controller received BOTH presses.
    expect(browser.clicks).toBe(2);
    const pause = conversationsRepository(db).listToolCallsForTask("t").find((item) => item.id === "pause");
    expect(pause?.status).toBe("completed");
    expect(pause?.resultJson).not.toContain('"duplicate":true');
  });

  it("does not flag a diligent repeated-snapshot verification flow as a loop", async () => {
    // Live bug (Pomodoro build, deepseek-v4-flash): a healthy end-to-end verify
    // flow snapshotted the page after every interaction — click Start, snapshot,
    // click Pause, snapshot, snapshot, click Start, snapshot, click Reset,
    // snapshot. Four identical browser_snapshot {} calls landed inside the loop
    // detector's 6-wide window and the task was killed with loop_detected at
    // turn 16 even though every call succeeded and made real progress. A dynamic
    // browser observation re-reads mutable page state and must not feed the
    // repeated-signature detector; only interaction/other tools should.
    const browser = new FakeBrowser();
    const snap = (id: string) => tool(id, "browser_snapshot", {}).toolCalls[0]!;
    // A long run of identical browser_snapshot {} calls, one per turn, exactly
    // like the live verify flow. Without the exemption the detector fires a
    // loop_recovery and then, unrecovered, a loop_detected interrupt.
    const provider = new ScriptedProvider([
      [tool("open", "browser_open", { url: "http://127.0.0.1:4173/" }), done],
      [{ type: "tool_call", toolCalls: [snap("s1")] }, done],
      [{ type: "tool_call", toolCalls: [snap("s2")] }, done],
      [{ type: "tool_call", toolCalls: [snap("s3")] }, done],
      [{ type: "tool_call", toolCalls: [snap("s4")] }, done],
      [{ type: "tool_call", toolCalls: [snap("s5")] }, done],
      [{ type: "tool_call", toolCalls: [snap("s6")] }, done],
      [{ type: "text", text: "Inspected the page across several observations; everything renders and responds correctly." }, done],
    ]);

    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => browser, maxTurns: 12 });

    const events = taskRecordsRepository(db).listEvents("t");
    // No loop machinery of any kind should engage for pure re-observation.
    expect(events.some((e) => e.type === "task.progress_warning" && (e.payload as any)?.reason === "loop_recovery")).toBe(false);
    expect(events.some((e) => e.type === "task.interrupted" && (e.payload as any)?.reason === "loop_detected")).toBe(false);
    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
  });

  it("does not let auto-approval authorize a purchase-like browser action", async () => {
    const browser = new FakeBrowser("Buy now");
    const provider = new ScriptedProvider([
      [{ type: "tool_call", toolCalls: [
        { ...tool("open", "browser_open", { url: "https://shop.example/" }).toolCalls[0]!, index: 0 },
        { ...tool("snapshot", "browser_snapshot", {}).toolCalls[0]!, index: 1 },
      ] }, done],
      [tool("buy", "browser_click", { ref: "e1" }), done],
      [{ type: "text", text: "The protected action was not performed." }, done],
    ]);

    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => browser, maxTurns: 6 });

    expect(browser.clicks).toBe(0);
    const call = conversationsRepository(db).listToolCallsForTask("t").find((item) => item.toolName === "browser_click");
    expect(call?.status).toBe("failed");
    expect(call?.resultJson).toMatch(/browser_sensitive_action_blocked/);
    expect(approvalsRepository(db).listByTask("t")).toHaveLength(1);
  });

  it("does not navigate before a manual origin approval is durably resolved", async () => {
    const now = new Date().toISOString();
    taskRoutingRepository(db).upsert({
      taskId: "t", presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", useMemory: false,
      decision: { version: 1, presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: false },
      createdAt: now,
    });
    const browser = new FakeBrowser();
    const provider = new ScriptedProvider([
      [tool("open", "browser_open", { url: "https://docs.example/" }), done],
      [{ type: "text", text: "Approved page opened." }, done],
    ]);

    const running = executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => browser, maxTurns: 4 });
    await vi.waitFor(() => expect(approvalsRepository(db).listByTask("t")[0]?.status).toBe("pending"));
    expect(browser.opens).toBe(0);
    const approval = approvalsRepository(db).listByTask("t")[0]!;
    approvalsRepository(db).resolve(approval.id, { decision: "allow_once", resolvedAt: new Date().toISOString() });
    ApprovalContinuationRegistry.resolveApproval(approval.id, "allow_once");
    await running;

    expect(browser.opens).toBe(1);
    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
  });

  it("persists screenshots but truthfully blocks pixel analysis on a model without verified vision support", async () => {
    const now = new Date().toISOString();
    taskRoutingRepository(db).upsert({
      taskId: "t", presetId: "best-quality", providerId: "deepseek", model: "deepseek-v4-pro", useMemory: false,
      decision: { version: 1, presetId: "best-quality", providerId: "deepseek", model: "deepseek-v4-pro", reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
      createdAt: now,
    });
    const provider = new ScriptedProvider([
      [{ type: "tool_call", toolCalls: [
        { ...tool("open", "browser_open", { url: "http://127.0.0.1:4173/" }).toolCalls[0]!, index: 0 },
        { ...tool("shot", "browser_screenshot", { label: "nonvision" }).toolCalls[0]!, index: 1 },
      ] }, done],
      [{ type: "text", text: "Screenshot saved, but pixel analysis was unavailable." }, done],
    ], "deepseek");

    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => new FakeBrowser(), maxTurns: 4 });

    const screenshot = taskRecordsRepository(db).listEvidence("t").find((item) => item.metadata.kind === "browser_screenshot");
    expect(screenshot?.metadata.vision).toBe("blocked");
    expect(provider.calls.flat().some((message) => message.images?.length)).toBe(false);
    expect(conversationsRepository(db).listToolCallsForTask("t").find((item) => item.toolName === "browser_screenshot")?.resultJson).toMatch(/blocked_model_route_not_verified_vision_capable/);
  });

  it.skipIf(!existsSync(chromium.executablePath()))("drives the production Playwright controller through the agent boundary", { timeout: 60_000 }, async () => {
    const server = createServer((_request, response) => response.end("<!doctype html><title>Agent browser</title><button aria-label='Inspect action' onclick=\"console.log('clicked')\">Inspect</button>"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local server port");
    const priorHeadless = process.env.MORROW_BROWSER_HEADLESS;
    process.env.MORROW_BROWSER_HEADLESS = "true";
    try {
      const url = `http://127.0.0.1:${address.port}/`;
      const calls = [
        tool("open", "browser_open", { url }).toolCalls[0]!,
        tool("snapshot", "browser_snapshot", {}).toolCalls[0]!,
        tool("mobile", "browser_viewport", { preset: "mobile" }).toolCalls[0]!,
        tool("shot", "browser_screenshot", { label: "real-mobile" }).toolCalls[0]!,
        tool("click", "browser_click", { ref: "e1" }).toolCalls[0]!,
        tool("console", "browser_console", {}).toolCalls[0]!,
      ].map((call, index) => ({ ...call, index }));
      const provider = new ScriptedProvider([
        [{ type: "tool_call", toolCalls: calls }, done],
        [{ type: "text", text: "The real page passed browser inspection." }, done],
      ]);

      await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

      expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
      const evidence = taskRecordsRepository(db).listEvidence("t").find((item) => item.metadata.label === "real-mobile");
      expect(readFileSync(evidence!.path).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      const consoleCall = conversationsRepository(db).listToolCallsForTask("t").find((item) => item.toolName === "browser_console");
      expect(consoleCall?.resultJson).toContain("clicked");
    } finally {
      if (priorHeadless === undefined) delete process.env.MORROW_BROWSER_HEADLESS;
      else process.env.MORROW_BROWSER_HEADLESS = priorHeadless;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
