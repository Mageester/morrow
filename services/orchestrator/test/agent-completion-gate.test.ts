import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService } from "../src/mission/service.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask, runCommandStartedBackgroundProcess } from "../src/execution/agent.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { actionAttemptsRepository } from "../src/repositories/action-attempts.js";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("runCommandStartedBackgroundProcess", () => {
  it("is true for a detached background server result (running, has pid, no exit code)", () => {
    expect(runCommandStartedBackgroundProcess(JSON.stringify({ processId: "abc", pid: 30768, status: "running", note: "Started in the background." }))).toBe(true);
  });
  it("is false for a completed command with exit code 0", () => {
    expect(runCommandStartedBackgroundProcess(JSON.stringify({ exitCode: 0, stdout: "ok" }))).toBe(false);
  });
  it("is false for a completed command with a non-zero exit code", () => {
    expect(runCommandStartedBackgroundProcess(JSON.stringify({ exitCode: 1, stderr: "boom" }))).toBe(false);
  });
  it("is false for a running result without a process id", () => {
    expect(runCommandStartedBackgroundProcess(JSON.stringify({ status: "running" }))).toBe(false);
  });
  it("is false for null/malformed results", () => {
    expect(runCommandStartedBackgroundProcess(null)).toBe(false);
    expect(runCommandStartedBackgroundProcess("not json")).toBe(false);
  });
});

function seedYolo(db: any, workspacePath: string, prompt = "verify it", missionLinked = false) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  const missionId = missionLinked
    ? new MissionService({ repo: missionsRepository(db), getWorkspacePath: () => workspacePath, backupDir: join(workspacePath, ".morrow-checkpoints") })
        .create("p", { objective: prompt }).id
    : undefined;
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", ...(missionId ? { missionId } : {}), kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
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

describe("agent completion gate", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-gate-"))); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("preserves a failed final verification as an honest completion blocker", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done],
        [text("all good"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation. The
        // model restates its claim without acting, so the run settles here
        // and the durable blockers below are the honest final evidence.
        [text("nothing further I can do"), done],
        [text("and I still have nothing to add"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    // The model's final answer ends execution; the failed verification remains
    // durable evidence rather than silently becoming a pass.
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const command = conversationsRepository(db).listToolCallsForTask("t")
      .find((call: any) => call.id === "v1");
    expect(command).toMatchObject({
      status: "failed",
      errorType: "command_exit_nonzero",
    });
    expect(command?.errorMessage).toContain("exited with status 1");
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) =>
      e.type === "tool.failed"
      && e.payload?.classification === "command_exit_nonzero"
      && e.payload?.exitCode === 1
    )).toBe(true);
    expect(events.some((e: any) => e.type === "task.completed")).toBe(true);
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({
      completion: { complete: false, blockers: expect.arrayContaining([expect.objectContaining({ code: "failed_final_verification" })]) },
    });
  });

  it("treats intentional exit codes 0 through 4 as passed evidence without retrying", async () => {
    seedYolo(db, ws);
    const expected = [0, 1, 2, 3, 4];
    const provider = new MockProvider({
      chunks: [
        ...expected.map((code) => [tool(`expected-${code}`, "run_command", {
          executable: "node",
          args: ["-e", `process.exit(${code})`],
          purpose: "verify expected fixture status",
          expectedExitCode: code,
        }), done] as any),
        [text("all intentional fixture statuses were verified"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 10 });

    const calls = conversationsRepository(db).listToolCallsForTask("t")
      .filter((call: any) => call.toolName === "run_command");
    expect(calls).toHaveLength(expected.length);
    for (const [index, code] of expected.entries()) {
      const call = calls[index]!;
      expect(call.status).toBe("completed");
      expect(JSON.parse(call.resultJson!).exitCode).toBe(code);
      expect(JSON.parse(call.resultJson!).expectedStatus).toBe("matched");
    }
    expect(actionAttemptsRepository(db).listForTask("t").every((attempt) => attempt.status === "succeeded")).toBe(true);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("classifies a timed-out verification as failed and keeps mission progress incomplete", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v-timeout", "run_command", {
          executable: "node",
          args: ["-e", "setTimeout(() => {}, 250)"],
          purpose: "verify",
          timeoutMs: 25,
        }), done],
        [text("all good"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation. The
        // model restates its claim without acting, so the run settles here
        // and the durable blockers below are the honest final evidence.
        [text("nothing further I can do"), done],
        [text("and I still have nothing to add"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

    const command = conversationsRepository(db).listToolCallsForTask("t")
      .find((call: any) => call.id === "v-timeout");
    expect(command).toMatchObject({
      status: "failed",
      errorType: "command_timeout",
    });
    const timedOutResult = JSON.parse(command!.resultJson!);
    expect(timedOutResult.terminationReason).toBe("timeout");
    // Windows taskkill commonly reports 1 while POSIX reports null after a
    // forced timeout. Termination reason, not platform signal encoding, is the
    // classification authority; exitCode must still remain durably present.
    expect(Object.hasOwn(timedOutResult, "exitCode")).toBe(true);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) =>
      event.type === "tool.failed"
      && event.payload?.classification === "command_timeout"
      && event.payload?.terminationReason === "timeout"
    )).toBe(true);
  });

  it("rejects a package-script verification when the workspace has no package.json", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("npm-guard", "run_command", { executable: "npm", args: ["test"], purpose: "verify" }), done],
        [text("cannot verify with npm here"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation. The
        // model restates its claim without acting, so the run settles here
        // and the durable blockers below are the honest final evidence.
        [text("npm remains unavailable here"), done],
        [text("npm is still not usable here"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

    const command = conversationsRepository(db).listToolCallsForTask("t")
      .find((call: any) => call.id === "npm-guard");
    expect(command).toMatchObject({ status: "failed", errorType: "tool_failed" });
    expect(command?.errorMessage).toContain("no package.json");
    // The guard fires before execution: no process ever ran, so no retry-memory
    // attempt exists and the failure cannot be misread as a flaky command.
    expect(actionAttemptsRepository(db).listForTask("t")).toEqual([]);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("executes repeated failed commands and keeps each result durable without strategy interruption", async () => {
    seedYolo(db, ws, "recover without repeating the same failed command", true);
    const failedCommand = { executable: "node", args: ["-e", "process.exit(7)"], purpose: "verify" };
    const provider = new MockProvider({
      chunks: [
        [tool("repeat-1", "run_command", failedCommand), done],
        [tool("repeat-2", "run_command", failedCommand), done],
        [tool("repeat-3", "run_command", failedCommand), done],
        [text("blocked by repeated command"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation. The
        // model restates its claim without acting, so the run settles here
        // and the durable blockers below are the honest final evidence.
        [text("the command keeps failing the same way"), done],
        [text("the command still fails identically"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    expect(actionAttemptsRepository(db).listForTask("t")).toEqual([
      expect.objectContaining({ toolCallId: "repeat-1", attemptNumber: 1, status: "failed", exitStatus: 7 }),
      expect.objectContaining({ toolCallId: "repeat-2", attemptNumber: 2, status: "failed", exitStatus: 7 }),
      expect.objectContaining({ toolCallId: "repeat-3", attemptNumber: 3, status: "failed", exitStatus: 7 }),
    ]);
    const calls = conversationsRepository(db).listToolCallsForTask("t");
    expect(calls.find((call: any) => call.id === "repeat-3"))
      .toMatchObject({ status: "failed", errorType: "command_exit_nonzero" });

    // The third failed result is still present exactly once in the next
    // provider request; it is an observation for the model, not an
    // orchestrator-authored strategy switch.
    const thirdResult = provider.requests[3]?.filter((message) => message.role === "tool" && message.toolCallId === "repeat-3");
    expect(thirdResult).toHaveLength(1);
    expect(thirdResult?.[0]?.content).toContain('"exitCode":7');
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) =>
      event.type === "tool.strategy_switch"
      || event.payload?.signal === "strategy_change_required"
      || event.payload?.reason === "loop_stalled"
    )).toBe(false);
  });

  it("reports completed when a failed verification is recovered by a later clean run", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done],
        [tool("v2", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "re-verify" }), done],
        [text("fixed and verified"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    // The later clean run cleared the outstanding failure, so completion is honest.
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("records a failed verification even when a later workspace write succeeds", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done],
        [tool("w1", "create_file", { path: "after-failure.txt", content: "changed\n" }), done],
        [text("fixed"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation. The
        // model restates its claim without acting, so the run settles here
        // and the durable blockers below are the honest final evidence.
        [text("no further change to make"), done],
        [text("there is still no change to make"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    expect(conversationsRepository(db).listToolCallsForTask("t").map((call: any) => call.id)).toEqual(["v1", "w1"]);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) => event.type === "task.completed")).toBe(true);
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });

  it("records that a later workspace write invalidates the verified state", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [tool("w1", "create_file", { path: "after-pass.txt", content: "changed\n" }), done],
        [text("still verified"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation. The
        // model restates its claim without acting, so the run settles here
        // and the durable blockers below are the honest final evidence.
        [text("the write did not change behaviour"), done],
        [text("the write still changes nothing"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) => event.type === "task.completed")).toBe(true);
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });

  it("records missing post-write verification without discarding the final answer", async () => {
    seedYolo(db, ws, "change the workspace and verify it", true);
    const provider = new MockProvider({
      chunks: [
        [tool("w1", "create_file", { path: "unverified.txt", content: "changed\n" }), done],
        [text("done without checking"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation. The
        // model restates its claim without acting, so the run settles here
        // and the durable blockers below are the honest final evidence.
        [text("I have nothing else to check"), done],
        [text("there is still nothing else to check"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) => event.type === "task.completed")).toBe(true);
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });

  it("still reports completed for an ordinary successful run", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [text("intermediate narration"), tool("v2", "git_status", {}), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")!.content).toBe("done");
    const terminalEvents = taskRecordsRepository(db).listEvents("t").filter((event: any) => event.type === "task.completed");
    expect(terminalEvents).toHaveLength(1);
  });

  it("does not report completed when a provider ends after tools without a final answer", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    expect(taskRecordsRepository(db).listEvents("t").some((e: any) => e.type === "task.completed")).toBe(false);
  });

  it("retries one empty post-tool provider turn before interrupting", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [done],
        [text("verified after transient empty provider response"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")!.content).toContain("verified after transient empty provider response");
  });

  it("recovers when a reasoning-heavy provider needs multiple empty continuations", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "verify" }), done],
        [done],
        [done],
        [done],
        [text("verified after output-limit continuations"), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")!.content).toContain("verified after output-limit continuations");
    expect(taskRecordsRepository(db).listEvents("t").filter((event) => event.payload.reason === "empty_provider_response"))
      .toHaveLength(3);
  });

  it("records a failed final node --check without interrupting the model final", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "bad.js", content: "function (\n" }), done],
        [tool("v1", "run_command", { executable: "node", args: ["--check", "bad.js"], purpose: "syntax check" }), done],
        [text("looks good"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation; the
        // model restates its claim without acting, so the run settles here.
        [text("the syntax error is beyond what I can fix"), done],
        [text("the syntax error still defeats me"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });

  it("records a failed final required write without discarding the model final", async () => {
    seedYolo(db, ws);
    // header declares old=5 but only 2 old lines are present → hunk mismatch.
    const malformed = "--- a/style.css\n+++ b/style.css\n@@ -1,5 +1,2 @@\n body {\n-  color: black;\n";
    const provider = new MockProvider({
      chunks: [
        [tool("c1", "create_file", { path: "style.css", content: "body {\n  color: black;\n}\n" }), done],
        [tool("p1", "propose_patch", { patch: malformed, explanation: "restyle", files: ["style.css"] }), done],
        [text("styled"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation; the
        // model restates its claim without acting, so the run settles here.
        [text("the patch cannot be reshaped"), done],
        [text("the patch still cannot be reshaped"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });

  it("distinguishes required verification from optional tool failure — an optional failure does not gate", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        // Required write + verify both succeed (clears any outstanding failure).
        [tool("c1", "create_file", { path: "ok.js", content: "console.log('ok');\n" }), done],
        [tool("v1", "run_command", { executable: "node", args: ["--check", "ok.js"], purpose: "verify" }), done],
        // A read-only search fails — this is NOT a required verification, so it
        // must not turn an otherwise-complete task into an incomplete one.
        [tool("s1", "search_text", { query: "" }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 10 }));
    runner.run("t");
    await runner.waitFor("t");

    // The search failure is recorded on its tool call, but the task still completes.
    const search = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.toolName === "search_text");
    expect(search!.status).toBe("failed");
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("keeps terminal states mutually exclusive when the gate fires", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("v1", "run_command", { executable: "node", args: ["-e", "process.exit(2)"], purpose: "verify" }), done],
        [text("all good"), done],
        // v0.8.1 grants a bounded "you are not finished" continuation. The
        // model restates its claim without acting, so the run settles here
        // and the durable blockers below are the honest final evidence.
        [text("nothing further I can do"), done],
        [text("and I still have nothing to add"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 6 }));
    runner.run("t");
    await runner.waitFor("t");

    const status = taskRepository(db).getTaskById("t")!.status;
    expect(status).toBe("completed");
    // Exactly one terminal state — interrupted — never also completed/failed/cancelled.
    expect(["failed", "cancelled"]).not.toContain(status);
    const events = taskRecordsRepository(db).listEvents("t");
    expect(events.some((e: any) => e.type === "task.interrupted")).toBe(false);
    expect(events.some((e: any) => e.type === "task.completed")).toBe(true);
    expect(events.some((e: any) => e.type === "task.failed")).toBe(false);
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({ completion: { complete: false } });
  });
});
