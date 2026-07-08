import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { changeSetsRepository } from "../src/repositories/change-sets.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { hashString } from "../src/tools/diff-applier.js";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Phase 2 — prove the automatic create_file → whole-file-edit switch cannot
 * cause an accidental destructive replacement, and that every mutation is
 * backed up and exactly recoverable. These are the workspace-safety invariants
 * for beta.27's edit recovery; they must never be weakened.
 */

function seedYolo(db: any, workspacePath: string, prompt = "build it") {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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

describe("create_file → edit safety", () => {
  let db: any;
  let ws: string;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-c2e-ws-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "morrow-c2e-home-")));
    prevHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = home; // isolate the content-addressed backup store
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    try { db.close(); } catch {}
    if (prevHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = prevHome;
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  async function run(chunks: any[]) {
    const provider = new MockProvider({ chunks, delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 16 }));
    runner.run("t");
    await runner.waitFor("t");
  }
  const createCalls = () => conversationsRepository(db).listToolCallsForTask("t").filter((c: any) => c.toolName === "create_file");

  it("replaces an existing file with the complete supplied content and reports the conversion", async () => {
    seedYolo(db, ws);
    const v1 = "line1\nline2\nline3\n";
    const v2 = "line1\nline2 CHANGED\nline3\nline4 added\n";
    await run([
      [tool("f1", "create_file", { path: "app.txt", content: v1 }), done],
      [tool("f2", "create_file", { path: "app.txt", content: v2, purpose: "improve" }), done],
      [text("done"), done],
    ]);

    expect(readFileSync(join(ws, "app.txt"), "utf8")).toBe(v2); // exact, complete content
    const calls = createCalls();
    expect(calls[1]!.status).toBe("completed");
    // Item 10: the result reports the create→edit conversion.
    const res = JSON.parse(calls[1]!.resultJson!);
    expect(res.convertedToEdit).toBe(true);
    expect(res.strategy).toBe("create_to_edit");
    // Item 9: the strategy-switch event is persisted and schema-valid (it loaded).
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "tool.strategy_switch" && e.payload.to === "edit")).toBe(true);
  });

  it("backs up the exact original bytes before mutating (undo is a byte-exact restore)", async () => {
    seedYolo(db, ws);
    const original = "const a = 1;\nconst b = 2;\n";
    await run([
      [tool("f1", "create_file", { path: "code.js", content: original }), done],
      [tool("f2", "create_file", { path: "code.js", content: "const a = 99;\n", purpose: "edit" }), done],
      [text("done"), done],
    ]);

    // Item 4 + 5: the change set records a backup keyed by the original hash, and
    // the backup file in the store holds the exact original bytes — which is what
    // the /undo route restores.
    const editCs = changeSetsRepository(db).listByTask("t").find((cs) => Object.keys(cs.backupReferences ?? {}).includes("code.js"));
    expect(editCs).toBeTruthy();
    const originalHash = editCs!.backupReferences!["code.js"]!;
    expect(originalHash).toBe(hashString(original));
    const backupFile = join(home, "backups", `${originalHash}.bak`);
    expect(existsSync(backupFile)).toBe(true);
    expect(readFileSync(backupFile, "utf8")).toBe(original); // byte-exact recoverability
  });

  it("refuses to overwrite a non-empty file with empty content (file preserved, call fails)", async () => {
    seedYolo(db, ws);
    await run([
      [tool("f1", "create_file", { path: "keep.txt", content: "important data\n" }), done],
      [tool("f2", "create_file", { path: "keep.txt", content: "", purpose: "oops" }), done],
      [text("done"), done],
    ]);

    // Safety outcome: the non-empty file is untouched and the blank overwrite
    // failed. Blank content is rejected by the tool-argument validator first
    // (invalid_tool_arguments); the create→edit path also carries a dedicated
    // unsafe_overwrite_rejected guard as defense in depth.
    expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("important data\n");
    const calls = createCalls();
    expect(calls[1]!.status).toBe("failed");
    expect(JSON.parse(calls[1]!.resultJson!).kind).toMatch(/unsafe_overwrite_rejected|invalid_tool_arguments/);
  });

  it("refuses to overwrite a non-empty file with whitespace-only content (truncation guard)", async () => {
    seedYolo(db, ws);
    await run([
      [tool("f1", "create_file", { path: "keep.txt", content: "real content here\n" }), done],
      [tool("f2", "create_file", { path: "keep.txt", content: "   \n\t\n", purpose: "truncated" }), done],
      [text("done"), done],
    ]);

    expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("real content here\n");
    const calls = createCalls();
    expect(calls[1]!.status).toBe("failed");
    expect(JSON.parse(calls[1]!.resultJson!).kind).toMatch(/unsafe_overwrite_rejected|invalid_tool_arguments/);
  });

  it("applies a non-blank shorter rewrite but keeps the original recoverable (not silently destroyed)", async () => {
    seedYolo(db, ws);
    const big = "header\n" + Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const small = "header\nsimplified\n";
    await run([
      [tool("f1", "create_file", { path: "doc.txt", content: big }), done],
      [tool("f2", "create_file", { path: "doc.txt", content: small, purpose: "simplify" }), done],
      [text("done"), done],
    ]);

    // A real (non-blank) rewrite IS applied — but it is audited (strategy switch)
    // and the exact prior bytes are recoverable from the backup store, so it is
    // never a silent destruction.
    expect(readFileSync(join(ws, "doc.txt"), "utf8")).toBe(small);
    const editCs = changeSetsRepository(db).listByTask("t").find((cs) => Object.keys(cs.backupReferences ?? {}).includes("doc.txt"));
    const originalHash = editCs!.backupReferences!["doc.txt"]!;
    expect(originalHash).toBe(hashString(big));
    expect(readFileSync(join(home, "backups", `${originalHash}.bak`), "utf8")).toBe(big);
  });

  it("treats an identical-content edit as patch_no_effect (not a hollow success)", async () => {
    seedYolo(db, ws);
    // Different `purpose` keeps the two calls from being deduped, so the second
    // reaches the edit path and its whole-file replacement is a true no-op.
    await run([
      [tool("f1", "create_file", { path: "same.txt", content: "same\n", purpose: "create" }), done],
      [tool("f2", "create_file", { path: "same.txt", content: "same\n", purpose: "reapply" }), done],
      [text("done"), done],
    ]);

    expect(readFileSync(join(ws, "same.txt"), "utf8")).toBe("same\n");
    const calls = createCalls();
    expect(calls[1]!.status).toBe("failed");
    expect(JSON.parse(calls[1]!.resultJson!).kind).toBe("patch_no_effect");
  });

  it("keeps repeated identical create_file calls bounded (no unbounded loop)", async () => {
    seedYolo(db, ws);
    await run([
      [tool("f1", "create_file", { path: "r.txt", content: "v\n" }), done],
      [tool("f2", "create_file", { path: "r.txt", content: "v\n" }), done],
      [tool("f3", "create_file", { path: "r.txt", content: "v\n" }), done],
      [text("done"), done],
    ]);
    // Task terminated (did not spin) and the file is intact.
    expect(["completed", "interrupted"]).toContain(taskRepository(db).getTaskById("t")!.status);
    expect(readFileSync(join(ws, "r.txt"), "utf8")).toBe("v\n");
  });

  it("denies a create_file target outside the workspace", async () => {
    seedYolo(db, ws);
    await run([
      [tool("f1", "create_file", { path: "../escape.txt", content: "x\n" }), done],
      [text("done"), done],
    ]);
    expect(existsSync(join(ws, "..", "escape.txt"))).toBe(false);
    const calls = createCalls();
    expect(calls[0]!.status).toBe("failed");
  });

  it("denies a create_file target that escapes via a symlink/junction", async () => {
    // Windows may forbid symlink creation without privilege; skip cleanly then.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "morrow-c2e-out-")));
    let linked = false;
    try {
      try { symlinkSync(outside, join(ws, "link"), "junction"); linked = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EPERM") return; throw e; }
      writeFileSync(join(outside, "secret.txt"), "secret\n");
      seedYolo(db, ws);
      await run([
        [tool("f1", "create_file", { path: "link/evil.txt", content: "x\n" }), done],
        [text("done"), done],
      ]);
      // Nothing was written outside the workspace and the call failed cleanly.
      expect(existsSync(join(outside, "evil.txt"))).toBe(false);
      expect(createCalls()[0]!.status).toBe("failed");
    } finally {
      if (linked) rmSync(join(ws, "link"), { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("errors (does not clobber) when a directory already occupies the target path", async () => {
    seedYolo(db, ws);
    mkdirSync(join(ws, "adir"));
    await run([
      [tool("f1", "create_file", { path: "adir", content: "x\n" }), done],
      [text("done"), done],
    ]);
    // The directory is untouched and the call failed cleanly.
    expect(existsSync(join(ws, "adir"))).toBe(true);
    const calls = createCalls();
    expect(calls[0]!.status).toBe("failed");
    expect(calls[0]!.errorMessage).toMatch(/non-file already exists/i);
  });
});
