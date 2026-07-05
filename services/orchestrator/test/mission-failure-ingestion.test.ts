import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService } from "../src/mission/service.js";
import { createMissionToolFailureReporter } from "../src/mission/tool-failure-reporter.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";

/**
 * Beta.20 gap: agents burned repeated malformed-patch attempts while the
 * mission failure ledger recorded zero failures. These tests prove agent tool
 * failures now become structured mission failure records that feed loop
 * detection, and that harmless noise stays out of the ledger.
 */

function newService(db: any, backupDir: string): MissionService {
  return new MissionService({
    repo: missionsRepository(db),
    getWorkspacePath: (pid) => projectRepository(db).getProjectById(pid)?.workspacePath,
    backupDir,
  });
}

describe("mission tool-failure reporter (unit)", () => {
  let db: any;
  let ws: string;
  let service: MissionService;
  let missionId: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "morrow-mfi-"));
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: ws, createdAt: new Date().toISOString() });
    service = newService(db, join(ws, "ckpt"));
    const mission = service.create("p", { objective: "test objective", autoApprove: true });
    missionId = mission.id;
    service.approveCriteria(missionId);
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  const reporter = (agentId?: string) => createMissionToolFailureReporter({
    service, missionId, taskId: "task-1", agentId: agentId ?? null,
  });

  it("records a structured failure with mission, task, category, signature, and attempt", () => {
    reporter("agent-9").reportFailure(
      "propose_patch",
      { patch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n-x\n+y\n" },
      "Hunk 1 failed: patch context mismatch at line 14",
      "tool_failed",
    );
    const failures = service.get(missionId).failures;
    expect(failures).toHaveLength(1);
    const f = failures[0]!;
    expect(f.missionId).toBe(missionId);
    expect(f.taskId).toBe("task-1");
    expect(f.agentId).toBe("agent-9");
    expect(f.operation).toBe("propose_patch src/app.ts");
    expect(f.category).toBe("patch_context_mismatch");
    expect(f.normalizedSignature).toContain("patch_context_mismatch:");
    expect(f.attempt).toBe(1);
    expect(f.recoveryStrategy).toBe("reread-target");
    expect(f.recovered).toBe(false);
  });

  it("collapses identical repeated failures into one signature bucket with rising attempts", () => {
    const r = reporter();
    for (let i = 0; i < 3; i++) {
      r.reportFailure("propose_patch", { patch: "--- a/src/app.ts\n+++ b/src/app.ts\n" }, `Hunk 1 failed: patch context mismatch at line ${10 + i}`, "tool_failed");
    }
    const failures = service.get(missionId).failures;
    expect(failures).toHaveLength(3);
    const signatures = new Set(failures.map((f) => f.normalizedSignature));
    expect(signatures.size).toBe(1); // volatile line numbers normalized away
    expect(failures.map((f) => f.attempt).sort()).toEqual([1, 2, 3]);
    // Loop detection fired on the third identical failure.
    const events = missionsRepository(db).listEvents(missionId);
    expect(events.some((e: any) => e.type === "mission.loop_detected")).toBe(true);
  });

  it("marks the whole failure bucket recovered when a later attempt on the same target succeeds", () => {
    const r = reporter();
    r.reportFailure("propose_patch", { patch: "--- a/src/app.ts\n+++ b/src/app.ts\n" }, "patch context mismatch", "tool_failed");
    r.reportFailure("propose_patch", { patch: "--- a/src/app.ts\n+++ b/src/app.ts\n" }, "patch context mismatch", "tool_failed");
    r.reportSuccess("propose_patch", { patch: "--- a/src/app.ts\n+++ b/src/app.ts\n" });
    const failures = service.get(missionId).failures;
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.recovered)).toBe(true);
  });

  it("a success on a different target does not mark unrelated failures recovered", () => {
    const r = reporter();
    r.reportFailure("propose_patch", { patch: "--- a/src/app.ts\n+++ b/src/app.ts\n" }, "patch context mismatch", "tool_failed");
    r.reportSuccess("propose_patch", { patch: "--- a/src/other.ts\n+++ b/src/other.ts\n" });
    expect(service.get(missionId).failures[0]!.recovered).toBe(false);
  });

  it("filters harmless noise: safe-read policy rejections and empty messages never reach the ledger", () => {
    const r = reporter();
    r.reportFailure("read_file", { path: "../outside.txt" }, "Path escapes the workspace", "safe_read_rejected");
    r.reportFailure("run_command", { command: "true" }, "   ", "tool_failed");
    expect(service.get(missionId).failures).toHaveLength(0);
  });

  it("a single denied command does not block the mission (loop-only escalation)", () => {
    const r = reporter();
    r.reportFailure("run_command", { command: "rm -rf ." }, "Command execution denied by user.", "tool_failed");
    const mission = service.get(missionId);
    expect(mission.failures).toHaveLength(1);
    expect(mission.status).not.toBe("blocked");
  });

  it("repeated identical denials do escalate the mission to blocked", () => {
    const r = reporter();
    for (let i = 0; i < 4; i++) {
      r.reportFailure("run_command", { command: "rm -rf ." }, "Command execution denied by user.", "tool_failed");
    }
    expect(service.get(missionId).status).toBe("blocked");
  });

  it("ledger write errors never break execution", () => {
    const broken = createMissionToolFailureReporter({
      service: { recordFailure() { throw new Error("db locked"); }, markRecovered() { throw new Error("db locked"); } } as any,
      missionId, taskId: "task-1",
    });
    expect(() => broken.reportFailure("run_command", { command: "x" }, "boom", "tool_failed")).not.toThrow();
    expect(() => broken.reportSuccess("run_command", { command: "x" })).not.toThrow();
  });

  it("tasks without a mission use a no-op reporter", () => {
    const noop = createMissionToolFailureReporter({ service, missionId: null, taskId: "task-1" });
    noop.reportFailure("run_command", { command: "x" }, "boom", "tool_failed");
    expect(service.get(missionId).failures).toHaveLength(0);
  });
});

// ── end-to-end: real agent execution feeds the mission ledger ────────────────

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

function seedMissionTask(db: any, workspacePath: string, missionId: string) {
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "go", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", missionId, createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
}

describe("mission failure ingestion (agent execution)", () => {
  let db: any;
  let ws: string;
  let service: MissionService;
  let missionId: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "morrow-mfi-e2e-"));
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p", name: "P", workspacePath: ws, createdAt: new Date().toISOString() });
    service = newService(db, join(ws, "ckpt"));
    const mission = service.create("p", { objective: "repair the widget", autoApprove: true });
    missionId = mission.id;
    service.approveCriteria(missionId);
    seedMissionTask(db, ws, missionId);
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("malformed patch attempts from a mission-linked agent land in the mission failure ledger", async () => {
    // Two malformed patch attempts (invalid diff → tool failure), then a plain
    // text turn ending the run: exactly the beta.20 acceptance shape.
    const badPatch = { patch: "this is not a unified diff", purpose: "fix" };
    const provider = new MockProvider({ chunks: [
      [tool("x1", "propose_patch", badPatch), done],
      [tool("x2", "propose_patch", badPatch), done],
      [text("giving up on the patch"), done],
    ], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    const mission = service.get(missionId);
    expect(mission.failures.length).toBeGreaterThanOrEqual(2);
    for (const f of mission.failures) {
      expect(f.missionId).toBe(missionId);
      expect(f.taskId).toBe("t");
      expect(f.operation).toContain("propose_patch");
      expect(f.message.length).toBeGreaterThan(0);
      expect(f.createdAt).toBeTruthy();
    }
    // Identical attempts share one signature with increasing attempt numbers.
    const signatures = new Set(mission.failures.map((f) => f.normalizedSignature));
    expect(signatures.size).toBe(1);
    expect(Math.max(...mission.failures.map((f) => f.attempt))).toBeGreaterThanOrEqual(2);
    // The ledger events exist for observability.
    const events = missionsRepository(db).listEvents(missionId);
    expect(events.filter((e: any) => e.type === "mission.failure_recorded").length).toBeGreaterThanOrEqual(2);
  });

  it("an agent task without a mission link leaves the ledger untouched", async () => {
    // Re-seed a second task without missionId.
    conversationsRepository(db).createConversation({ id: "c2", projectId: "p", title: "t2", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    conversationsRepository(db).appendMessage({ id: "mu2", conversationId: "c2", role: "user", content: "go", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    taskRepository(db).createTask({ id: "t2", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
    conversationsRepository(db).appendMessage({ id: "ma2", conversationId: "c2", role: "assistant", content: "", taskId: "t2", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    taskRoutingRepository(db).upsert({
      taskId: "t2", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
      decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
      createdAt: new Date().toISOString(),
    });
    taskRecordsRepository(db).transitionAgentState("t2", { id: "s2", state: "idle", details: {}, createdAt: new Date().toISOString() });

    const provider = new MockProvider({ chunks: [
      [tool("y1", "propose_patch", { patch: "not a diff", purpose: "fix" }), done],
      [text("done"), done],
    ], delayMs: 1 });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 4 }));
    runner.run("t2");
    await runner.waitFor("t2");

    expect(service.get(missionId).failures).toHaveLength(0);
  });

  it("mission link survives persistence: task row carries mission_id and maps back", () => {
    const row = taskRepository(db).getTaskById("t")!;
    expect((row as any).missionId).toBe(missionId);
  });
});
