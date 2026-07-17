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
import { mkdtempSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Phase 4 — deterministic reproduction of the beta.26 public failure.
 *
 * Observed beta.26 sequence that dead-ended: create the three site files →
 * reread them → verify → attempt a second-pass visual improvement whose first
 * patch has a hunk line-count mismatch → recovery rereads style.css → the model
 * then calls create_file against the *existing* style.css. In beta.26 that last
 * step failed ("it already exists") and the run looped / never converged.
 *
 * beta.27 must: surface the malformed patch once (no loop), hand back fresh file
 * context, auto-switch create_file to a backed-up edit, actually apply the
 * improvement, and reach exactly one completed state.
 */

function seed(db: any, workspacePath: string, prompt: string) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

class FrontendBrowser implements BrowserController {
  readonly id = "frontend-test";
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
  async screenshot() { return Buffer.from("frontend screenshot"); }
  evidence(): BrowserEvidence[] { return []; }
  async pause() {}
  async resume() {}
  async panic() {}
  async close() {}
}

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

const INDEX = "<!doctype html>\n<html>\n<head><link rel=\"stylesheet\" href=\"style.css\"></head>\n<body><h1>Site</h1><script src=\"script.js\"></script></body>\n</html>\n";
const SCRIPT = "console.log('ready');\n";
const STYLE_V1 = "body {\n  color: black;\n  margin: 0;\n}\n";
const STYLE_V2 = "body {\n  color: navy;\n  margin: 0;\n  font-family: system-ui, sans-serif;\n  line-height: 1.5;\n}\n";

// A patch whose header declares old=5 lines but whose body only accounts for 2 —
// a genuine hunk line-count mismatch, which parseUnifiedDiff rejects.
const MALFORMED_PATCH = "--- a/style.css\n+++ b/style.css\n@@ -1,5 +1,9 @@\n body {\n-  color: black;\n+  color: navy;\n}\n";

describe("beta.26 public failure — deterministic regression", () => {
  let db: any;
  let ws: string;
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-b26-ws-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "morrow-b26-home-")));
    prevHome = process.env.MORROW_HOME; process.env.MORROW_HOME = home;
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    try { db.close(); } catch {}
    if (prevHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = prevHome;
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("recovers from a hunk mismatch and lands the visual improvement via create→edit, exactly once completed", async () => {
    seed(db, ws, "Build index.html, style.css, script.js, then improve the styling.");
    const provider = new MockProvider({
      chunks: [
        // 1. Create the three files.
        [tool("c1", "create_file", { path: "index.html", content: INDEX }), done],
        [tool("c2", "create_file", { path: "style.css", content: STYLE_V1 }), done],
        [tool("c3", "create_file", { path: "script.js", content: SCRIPT }), done],
        // 2. Reread all three.
        [tool("r1", "read_file", { path: "index.html" }), done],
        [tool("r2", "read_file", { path: "style.css" }), done],
        [tool("r3", "read_file", { path: "script.js" }), done],
        // 3. Verify.
        [tool("v1", "run_command", { executable: "node", args: ["--check", "script.js"], purpose: "verify script" }), done],
        // 4./5. Second-pass visual improvement — first patch has a hunk mismatch.
        [tool("p1", "propose_patch", { patch: MALFORMED_PATCH, explanation: "restyle", files: ["style.css"] }), done],
        // 6. Recovery rereads current style.css.
        [tool("r4", "read_file", { path: "style.css" }), done],
        // 7. Model falls back to create_file against the EXISTING style.css.
        [tool("c4", "create_file", { path: "style.css", content: STYLE_V2, purpose: "apply improved styling" }), done],
        // 8. Re-verify, then finish.
        [tool("v2", "run_command", { executable: "node", args: ["--check", "script.js"], purpose: "re-verify" }), done],
        frontendValidationTurn(),
        [text("Styling improved and verified."), done],
      ],
      delayMs: 1,
    });
    (provider as any).id = "openai";
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FrontendBrowser(), maxTurns: 24 }));
    runner.run("t");
    await runner.waitFor("t");

    // The improvement actually applied and the file is intact (valid CSS body block).
    const finalCss = readFileSync(join(ws, "style.css"), "utf8");
    expect(finalCss).toBe(STYLE_V2);
    expect(finalCss).toContain("color: navy");
    expect(finalCss.trim().startsWith("body {")).toBe(true);
    expect(finalCss.trim().endsWith("}")).toBe(true);

    const calls = conversationsRepository(db).listToolCallsForTask("t");

    // The malformed patch surfaced exactly once as a failure (no repeated loop).
    const patchCalls = calls.filter((c: any) => c.toolName === "propose_patch");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.status).toBe("failed");
    const patchResult = JSON.parse(patchCalls[0]!.resultJson!);
    expect(patchResult.kind).toBe("patch_recovery_feedback");
    expect(patchResult.conflictCategory).toBe("malformed_patch");
    // Fresh file context was handed back for recovery.
    expect(patchResult.currentFile?.content).toContain("color: black");

    // create_file against the existing style.css switched to a backed-up edit.
    const styleCreate = calls.find((c: any) => c.id === "c4");
    expect(styleCreate!.status).toBe("completed");
    expect(JSON.parse(styleCreate!.resultJson!).convertedToEdit).toBe(true);

    // Exactly one terminal outcome, and it is "completed": no interrupted,
    // failed, or cancelled terminal event, and the final status is completed.
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.interrupted")).toBe(false);
    expect(events.some((e: any) => e.type === "task.failed")).toBe(false);
    expect(events.some((e: any) => e.type === "task.cancelled")).toBe(false);
    expect(events.some((e: any) => e.type === "task.completed")).toBe(true);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("escalates to create_file after repeated differently-broken diffs on the same file (the live loop)", async () => {
    seed(db, ws, "Improve the styling of style.css.");
    // Two malformed patches with DIFFERENT headers (different hashes) — the
    // real DeepSeek Flash loop, where no per-hash counter ever trips. The
    // per-file counter must trip on the second and steer to create_file.
    const bad1 = "--- a/style.css\n+++ b/style.css\n@@ -1,5 +1,9 @@\n body {\n-  color: black;\n";
    const bad2 = "--- a/style.css\n+++ b/style.css\n@@ -2,4 +2,7 @@\n  color: black;\n+  color: navy;\n";
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "style.css", content: STYLE_V1 }), done],
        [tool("p1", "propose_patch", { patch: bad1, explanation: "restyle", files: ["style.css"] }), done],
        [tool("p2", "propose_patch", { patch: bad2, explanation: "restyle again", files: ["style.css"] }), done],
        // The model follows the escalation: full-content create_file.
        [tool("c2", "create_file", { path: "style.css", content: STYLE_V2, purpose: "apply styling" }), done],
        frontendValidationTurn(),
        [text("done"), done],
      ],
      delayMs: 1,
    });
    (provider as any).id = "openai";
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, browserFactory: () => new FrontendBrowser(), maxTurns: 20 }));
    runner.run("t");
    await runner.waitFor("t");

    const calls = conversationsRepository(db).listToolCallsForTask("t");
    const p1 = calls.find((c: any) => c.id === "p1")!;
    const p2 = calls.find((c: any) => c.id === "p2")!;
    expect(p1.status).toBe("failed");
    expect(p2.status).toBe("failed");
    // Both are different patches (different hashes) yet the SECOND failure on the
    // same file escalates — proving per-file, not per-hash, counting.
    const p1r = JSON.parse(p1.resultJson!);
    const p2r = JSON.parse(p2.resultJson!);
    expect(p1r.switchToCreateFile).toBe(false);
    expect(p2r.switchToCreateFile).toBe(true);
    expect(p2r.attemptsForFile).toBe(2);
    expect(p2r.instruction).toMatch(/create_file/);

    // The escalation worked: the improvement is applied via create→edit.
    expect(readFileSync(join(ws, "style.css"), "utf8")).toBe(STYLE_V2);
    expect(calls.find((c: any) => c.id === "c2")!.status).toBe("completed");
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });
});
