import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDatabase,
  buildServer,
  TaskRunner,
  executeAgentChatTask,
  MockProvider,
} from "@morrow/orchestrator";
import { MorrowApi } from "../src/client/api.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, "../../../fixtures/agent-repair");

const REPAIR_PATCH = [
  "--- a/src/math.mjs",
  "+++ b/src/math.mjs",
  "@@ -1,4 +1,4 @@",
  " export function add(a, b) {",
  "   // Defect: subtracts instead of adds; the repair changes minus to plus.",
  "-  return a - b;",
  "+  return a + b;",
  " }",
  "",
].join("\n");

function toolChunk(id: string, name: string, args: unknown) {
  return { type: "tool_call", toolCalls: [{ id, index: 0, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
const done = { type: "done" };
const textChunk = (t: string) => ({ type: "text", text: t });

function copyFixture(dest: string): void {
  mkdirSync(join(dest, "src"), { recursive: true });
  mkdirSync(join(dest, "test"), { recursive: true });
  writeFileSync(join(dest, "package.json"), readFileSync(join(FIXTURE_DIR, "package.json"), "utf8"));
  writeFileSync(join(dest, "src", "math.mjs"), readFileSync(join(FIXTURE_DIR, "src", "math.mjs"), "utf8"));
  writeFileSync(join(dest, "test", "run.mjs"), readFileSync(join(FIXTURE_DIR, "test", "run.mjs"), "utf8"));
}

/**
 * End-to-end coverage through the real CLI client (`MorrowApi`) over HTTP
 * against a real orchestrator, real SQLite, the real command executor, and real
 * patch/rollback — only the model provider is mocked for deterministic tool
 * calls. This is the CLI-side counterpart to the orchestrator repository e2e.
 */
describe("CLI ⇄ orchestrator agent repair (real client path)", () => {
  let app: any;
  let db: any;
  let runner: TaskRunner;
  let api: MorrowApi;
  let activeTaskId: string | undefined;
  let tempWorkspace: string;
  let tempHome: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempHome = mkdtempSync(join(tmpdir(), "morrow-cli-home-"));
    process.env.MORROW_HOME = tempHome;
    process.env.MOCK_PROVIDER = "true";
    tempWorkspace = mkdtempSync(join(tmpdir(), "morrow-cli-ws-"));
    copyFixture(tempWorkspace);

    const provider = new MockProvider({
      delayMs: 5,
      chunks: [
        [toolChunk("tc-1", "read_file", { path: "package.json" }), done],
        [textChunk("Running the test."), toolChunk("tc-2", "run_command", { executable: "node", args: ["test/run.mjs"], purpose: "Run the failing test" }), done],
        [textChunk("Reading source."), toolChunk("tc-3", "read_file", { path: "src/math.mjs" }), done],
        [textChunk("Proposing a fix."), toolChunk("tc-4", "propose_patch", { patch: REPAIR_PATCH, explanation: "Add instead of subtract", files: ["src/math.mjs"] }), done],
        [textChunk("Verifying."), toolChunk("tc-5", "run_command", { executable: "node", args: ["test/run.mjs"], purpose: "Verify the fix" }), done],
        [textChunk("Verified: the test now passes."), done],
      ],
    } as any);

    db = openDatabase(":memory:");
    runner = new TaskRunner(db, async (deps) => {
      await executeAgentChatTask({
        db: deps.db,
        taskId: deps.taskId,
        provider,
        maxTurns: 12,
        ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}),
      });
    });
    app = buildServer({ db, runner, sseIntervalMs: 10 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    api = new MorrowApi(`http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (activeTaskId && runner.isActive(activeTaskId)) {
      const settled = new Promise<void>((resolve) => {
        const unsubscribe = runner.onSettled((taskId) => {
          if (taskId !== activeTaskId) return;
          unsubscribe();
          resolve();
        });
      });
      runner.cancel(activeTaskId);
      await settled;
    }
    if (app) { try { await app.close(); } catch { /* ignore */ } }
    if (db) { try { db.close(); } catch { /* ignore */ } }
    rmSync(tempWorkspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function nextPendingApproval(projectId: string): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const pending = await api.listApprovals(projectId, "pending");
      if (pending.length > 0) return pending[0]!.id;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Timeout waiting for pending approval");
  }

  it("drives the full approval → patch → verify → diff → undo workflow via MorrowApi", async () => {
    const project = await api.createProject("CLI E2E", tempWorkspace);
    const conversation = await api.createConversation(project.id, "Repair");

    const sent = await api.sendMessage(conversation.id, "Fix the failing test", { preset: "best-quality" });
    const taskId = sent.task.id;
    activeTaskId = taskId;

    // 1. Command approval surfaces through the client.
    const cmd1 = await nextPendingApproval(project.id);
    const a1 = await api.getApproval(cmd1);
    expect(a1.kind).toBe("command");
    expect((a1.details as any).executable).toBe("node");
    await api.resolveApproval(cmd1, { projectId: project.id, decision: "allow_once" });

    // 2. Patch approval carries the exact diff for the client to render.
    const patchApproval = await nextPendingApproval(project.id);
    const a2 = await api.getApproval(patchApproval);
    expect(a2.kind).toBe("change_set");
    expect((a2.details as any).diff).toContain("+  return a + b;");
    expect(readFileSync(join(tempWorkspace, "src", "math.mjs"), "utf8")).toContain("return a - b;");
    await api.resolveApproval(patchApproval, { projectId: project.id, decision: "allow_once" });

    // 3. Verification command approval.
    const cmd2 = await nextPendingApproval(project.id);
    await api.resolveApproval(cmd2, { projectId: project.id, decision: "allow_once" });

    // 4. Poll task to completion through the client.
    const start = Date.now();
    let status = "";
    while (Date.now() - start < 15000) {
      status = (await api.getTask(taskId)).task.status;
      if (["completed", "failed", "cancelled"].includes(status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe("completed");
    expect(readFileSync(join(tempWorkspace, "src", "math.mjs"), "utf8")).toContain("return a + b;");

    // 5. /diff via the client shows the Morrow-owned change.
    const diff = await api.getTaskDiff(taskId);
    expect(diff.diff).toContain("+  return a + b;");
    expect(diff.files).toContain("src/math.mjs");
    expect(existsSync(join(tempHome, "backups"))).toBe(true);

    // 6. /undo via the client restores the original file.
    const undo = await api.undoTask(taskId);
    expect(undo.status).toBe("success");
    expect(readFileSync(join(tempWorkspace, "src", "math.mjs"), "utf8")).toContain("return a - b;");
  }, 45000);

  it("leaves files untouched when the patch approval is denied via the client", async () => {
    const project = await api.createProject("CLI E2E Deny", tempWorkspace);
    const conversation = await api.createConversation(project.id, "Deny");
    const sent = await api.sendMessage(conversation.id, "Fix the failing test", { preset: "best-quality" });
    activeTaskId = sent.task.id;

    const cmd1 = await nextPendingApproval(project.id);
    await api.resolveApproval(cmd1, { projectId: project.id, decision: "allow_once" });

    const patchApproval = await nextPendingApproval(project.id);
    await api.resolveApproval(patchApproval, { projectId: project.id, decision: "deny" });

    // The file is never modified after a denied patch.
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(join(tempWorkspace, "src", "math.mjs"), "utf8")).toContain("return a - b;");
  }, 45000);
});
