import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "../src/provider/base.js";
import type { BrowserController, BrowserEvidence, BrowserViewport, PageSnapshot } from "../src/browser/types.js";

// Beta.32 packaged-acceptance regression: browser element refs (e1, e2, …) are
// regenerated per snapshot in DOM order, so "click e1" on two DIFFERENT pages
// shares identical arguments while being genuinely different work. The loop
// detector misread systematic nav-clicking across pages as "the same action
// repeated 3 times" and interrupted the HALOFORM mission mid-validation.
// Browser loop signatures are now scoped to the page acted on; clicking the
// same ref on the SAME page three times must still loop.

class ScriptedProvider implements AiProvider {
  readonly id = "openai";
  private turn = 0;
  constructor(private readonly turns: ProviderChunk[][]) {}
  async *streamChat(_messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
    for (const chunk of this.turns[this.turn++] ?? [{ type: "text", text: "done" }, { type: "done" }]) yield chunk;
  }
}

class NavFakeBrowser implements BrowserController {
  readonly id = "fake-browser";
  closed = false;
  clicks = 0;
  private url = "about:blank";
  async start(): Promise<void> {}
  async open(url: string): Promise<PageSnapshot> { this.url = url; return this.snapshot(); }
  async snapshot(): Promise<PageSnapshot> {
    return { url: this.url, title: "HALOFORM", viewport: { width: 1280, height: 720 }, refs: [{ ref: "e1", role: "link", name: "Journal" }], text: "page", injectionFindings: 0 };
  }
  async setViewport(_viewport: BrowserViewport): Promise<void> {}
  async click(): Promise<void> { this.clicks += 1; }
  async type(): Promise<void> {}
  async key(): Promise<void> {}
  async select(): Promise<void> {}
  async upload(): Promise<void> {}
  async download(): Promise<{ path: string; filename: string }> { return { path: "d.txt", filename: "d.txt" }; }
  async setDialogHandler(): Promise<void> {}
  async screenshot(): Promise<Buffer> { return Buffer.from("png"); }
  evidence(): BrowserEvidence[] { return []; }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async panic(): Promise<void> { await this.close(); }
  async close(): Promise<void> { this.closed = true; }
}

const tool = (id: string, name: string, args: unknown): ProviderChunk => ({ type: "tool_call", toolCalls: [{ id, index: 0, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const done: ProviderChunk = { type: "done" };
const text = (t: string): ProviderChunk => ({ type: "text", text: t });

describe("browser loop signatures are page-scoped", () => {
  let db: ReturnType<typeof openDatabase>;
  let workspace: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-browser-loop-"));
    priorHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = join(workspace, ".morrow-home");
    const now = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: workspace, createdAt: now });
    conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "browser", createdAt: now, updatedAt: now });
    conversationsRepository(db).appendMessage({ id: "u", conversationId: "c", role: "user", content: "Validate this site in the browser across pages.", createdAt: now, updatedAt: now });
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

  it("clicking the same ref across DIFFERENT pages is not a loop", async () => {
    const browser = new NavFakeBrowser();
    const provider = new ScriptedProvider([
      [tool("o1", "browser_open", { url: "http://localhost:4173/" }), done],
      [tool("c1", "browser_click", { ref: "e1" }), done],
      [tool("o2", "browser_open", { url: "http://localhost:4173/journal" }), done],
      [tool("c2", "browser_click", { ref: "e1" }), done],
      [tool("o3", "browser_open", { url: "http://localhost:4173/technology" }), done],
      [tool("c3", "browser_click", { ref: "e1" }), done],
      [text("validated across pages"), done],
    ]);
    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => browser, maxTurns: 10 });

    const task = taskRepository(db).getTaskById("t");
    expect(task?.status).toBe("completed");
    // Every cross-page click must REALLY execute — the duplicate-work
    // suppression must not serve a cached result for a different page.
    expect(browser.clicks).toBe(3);
  }, 60_000);

  it("clicking the same ref on the SAME page three times still loops", async () => {
    const browser = new NavFakeBrowser();
    const provider = new ScriptedProvider([
      [tool("o1", "browser_open", { url: "http://localhost:4173/" }), done],
      [tool("c1", "browser_click", { ref: "e1" }), done],
      [tool("c2", "browser_click", { ref: "e1" }), done],
      [tool("c3", "browser_click", { ref: "e1" }), done],
      [text("still clicking"), done],
    ]);
    await executeAgentChatTask({ db, taskId: "t", provider, browserFactory: () => browser, maxTurns: 10 });

    const task = taskRepository(db).getTaskById("t");
    expect(task?.status).toBe("interrupted");
  }, 60_000);
});
