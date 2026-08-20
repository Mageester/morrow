import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MissionRuntimeState, MissionStatus, TaskStatus } from "@morrow/contracts";
import { MAX_PLAN_REVISIONS } from "@morrow/contracts";
import { openDatabase } from "../src/database.js";
import { terminalDispositionForMission, TERMINAL_ENTRY_KINDS, type TerminalEntryKind } from "../src/mission/terminal-outcome.js";
import { MissionController, type ControllerSnapshot } from "../src/mission/controller.js";
import { MissionService } from "../src/mission/service.js";
import { createDefaultMissionControllerRunner, MissionControllerRunner } from "../src/mission/controller-runner.js";
import { reconcileMissionsOnStartup } from "../src/recovery.js";
import { CortexService } from "../src/cortex/service.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";
import type { ProviderChunk } from "../src/provider/base.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { intelligenceRepository } from "../src/repositories/intelligence.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { TaskRunner } from "../src/runner.js";

type TerminalScenario = {
  kind: TerminalEntryKind;
  missionStatus: MissionStatus;
  initialRuntimeState: MissionRuntimeState;
  expectedRuntimeState: MissionRuntimeState;
  taskStatus: TaskStatus;
};

const scenarios: TerminalScenario[] = [
  { kind: "normal_finalize", missionStatus: "completed", initialRuntimeState: "validating", expectedRuntimeState: "completed", taskStatus: "completed" },
  { kind: "user_cancel", missionStatus: "cancelled", initialRuntimeState: "executing", expectedRuntimeState: "cancelled", taskStatus: "running" },
  { kind: "controller_exhausted", missionStatus: "blocked", initialRuntimeState: "recovering", expectedRuntimeState: "blocked", taskStatus: "interrupted" },
  { kind: "tool_loop_exhausted", missionStatus: "blocked", initialRuntimeState: "executing", expectedRuntimeState: "blocked", taskStatus: "interrupted" },
  { kind: "revision_limit", missionStatus: "blocked", initialRuntimeState: "recovering", expectedRuntimeState: "blocked", taskStatus: "interrupted" },
  { kind: "startup_reconciliation", missionStatus: "blocked", initialRuntimeState: "blocked", expectedRuntimeState: "blocked", taskStatus: "queued" },
];

const now = "2026-08-02T12:00:00.000Z";
const guardianPassed: ControllerSnapshot["guardianDecision"] = {
  passed: true,
  missing: [],
  failed: [],
  blocked: [],
  nextActions: [],
  evidenceSnapshot: {
    missionId: "mission-1",
    criteria: { total: 1, satisfied: 1 },
    requirements: { authoritative: 1, satisfied: 1 },
    evidence: { passed: 1, failed: 0, inconclusive: 0 },
    operations: { resolved: 1, unresolved: 0 },
    tasks: { resolved: 1, unresolved: 0 },
    approvals: { resolved: 0, unresolved: 0 },
    validation: { required: ["tests"], completed: ["tests"] },
    changedFiles: [],
  },
};

type Fixture = {
  db: ReturnType<typeof openDatabase>;
  repo: ReturnType<typeof missionsRepository>;
  service: MissionService;
  missionId: string;
  taskRunner?: ObservableTaskRunner;
};

const activeRunners: TaskRunner[] = [];

type ObservableTaskRunner = {
  isActive(taskId: string): boolean;
  waitFor(taskId: string): Promise<void>;
  cancel?(taskId: string, reason?: "mission_terminal" | "user_cancelled" | "parent_cancelled"): void;
};

/**
 * Every fixture gets its own empty, committed git repository.
 *
 * This suite used to point both the mission workspace and the backup directory
 * at `process.cwd()` — the live Morrow checkout. Mission finalization inspects
 * the workspace's git state, so the outcome depended on whether the developer
 * happened to have uncommitted changes: with a dirty tree the guardian saw
 * unexplained changed files, `normal_finalize` dispatched a worker instead of
 * finalizing, and the scenario failed with an unrelated foreign-key error. It
 * also meant the suite wrote backup files into the repository it was running
 * from. An isolated workspace makes the conformance result depend only on the
 * code under test.
 */
const workspaces: string[] = [];

function createIsolatedWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "morrow-terminal-conformance-"));
  const git = (args: string) => execFileSync("git", args.split(" "), { cwd: root, stdio: "ignore" });
  git("init --quiet");
  git("config user.email conformance@morrow.test");
  git("config user.name Conformance");
  git("config commit.gpgsign false");
  writeFileSync(join(root, "README.md"), "conformance workspace\n");
  git("add -A");
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root, stdio: "ignore" });
  workspaces.push(root);
  return root;
}

function createFixture(): Fixture {
  const db = openDatabase(":memory:");
  const workspacePath = createIsolatedWorkspace();
  projectRepository(db).createProject({ id: "project-1", name: "Project", workspacePath, createdAt: now });
  const repo = missionsRepository(db);
  const service = new MissionService({
    repo,
    getWorkspacePath: () => workspacePath,
    backupDir: join(workspacePath, ".morrow-backups"),
    now: () => now,
    completion: async (_messages, options) => options.purpose === "review"
      ? { text: JSON.stringify({ verdict: "approved", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], recommendedStatus: "completed", summary: "ok" }) }
      : { text: "[]" },
    runOptions: { exec: async () => ({ exitCode: 0, output: "ok", timedOut: false }) },
  });
  const mission = service.create("project-1", { objective: "Complete the work" });
  service.approveCriteria(mission.id);
  return { db, repo, service, missionId: mission.id };
}

function createTask(
  fixture: Fixture,
  input: { id?: string; status?: TaskStatus; linkMission?: boolean } = {},
) {
  return taskRepository(fixture.db).createTask({
    id: input.id ?? "task-1",
    projectId: "project-1",
    ...(input.linkMission === false ? {} : { missionId: fixture.missionId }),
    kind: "agent_chat",
    status: input.status ?? "queued",
    createdAt: now,
  });
}

function runningTaskRunner(db: Fixture["db"]): TaskRunner {
  const records = taskRecordsRepository(db);
  return new TaskRunner(db, async ({ taskId, abortSignal }) => {
    const task = taskRepository(db).getTaskById(taskId);
    if (task?.status === "queued") {
      records.transitionTask(taskId, "running", { id: `${taskId}-running`, createdAt: now, payload: {} });
    }
    await new Promise<void>((resolve) => {
      if (abortSignal?.aborted) return resolve();
      abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
  });
}

async function startTask(runner: TaskRunner, taskId: string): Promise<void> {
  runner.run(taskId);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function terminalKindFromEvents(fixture: Fixture, taskId: string): TerminalEntryKind | undefined {
  const missionEvents = [...fixture.repo.listEvents(fixture.missionId)].reverse();
  const taskEvents = [...taskRecordsRepository(fixture.db).listEvents(taskId)].reverse();
  const candidate = taskEvents.find((event) => typeof event.payload?.terminalEntryKind === "string")?.payload?.terminalEntryKind
    ?? missionEvents.find((event) => typeof event.data.terminalEntryKind === "string")?.data.terminalEntryKind;
  return typeof candidate === "string" && TERMINAL_ENTRY_KINDS.includes(candidate as TerminalEntryKind)
    ? candidate as TerminalEntryKind
    : undefined;
}

function exhaustedRecovery(kind: TerminalEntryKind) {
  return {
    category: "process_interruption" as const,
    diagnosis: `Worker entered terminal path ${kind}.`,
    failedStrategyFingerprint: `worker:${kind}`,
    nextStrategyFingerprint: null,
    action: "block_precisely" as const,
    retryCondition: null,
    exhausted: true,
  };
}

async function settleControllerPath(
  fixture: Fixture,
  taskId: string,
  initialState: MissionRuntimeState,
  taskRunner: ObservableTaskRunner,
  loadSnapshot: () => ControllerSnapshot,
  finalizeMission?: (missionId: string) => Promise<unknown> | unknown,
): Promise<void> {
  const runtime = missionRuntimeRepository(fixture.db);
  runtime.create({ missionId: fixture.missionId, state: initialState, now });
  fixture.db.prepare("UPDATE mission_runtime SET active_task_id=? WHERE mission_id=?").run(taskId, fixture.missionId);
  const controller = new MissionController({
    runtime,
    loadSnapshot,
    dispatchWorker: () => ({ taskId: "task-duplicate" }),
    finalizeMission: finalizeMission ?? (() => undefined),
    deferTerminalOutcomes: true,
    now: () => now,
  });
  const controllerRunner = new MissionControllerRunner({
    runtime,
    controller,
    taskRunner,
    ownerId: `conformance-${fixture.missionId}`,
    now: () => now,
    concludeTerminalOutcome: (missionId, input) => fixture.service.concludeTerminalOutcome(missionId, input),
  });
  controllerRunner.run(fixture.missionId);
  await controllerRunner.waitFor(fixture.missionId);
}

function repeatedFailureTurn(): ProviderChunk[] {
  return [
    {
      type: "tool_call",
      toolCalls: [{ id: "forbidden", index: 0, type: "function", function: { name: "unknown_tool", arguments: JSON.stringify({ target: "same" }) } }],
    },
    { type: "done" },
  ];
}

async function runNormalFinalize(fixture: Fixture, scenario: TerminalScenario): Promise<string> {
  const criterion = fixture.service.addCriterion(fixture.missionId, "The suite passes", { kind: "test", command: "npm test", expectExitCode: 0 });
  fixture.service.approveCriteria(fixture.missionId);
  await fixture.service.verifyCriterion(fixture.missionId, criterion.id);
  await fixture.service.runReview(fixture.missionId);
  const task = createTask(fixture, { status: "completed", linkMission: false });
  const taskRunner: ObservableTaskRunner = { isActive: () => false, waitFor: async () => undefined };
  fixture.taskRunner = taskRunner;
  await settleControllerPath(
    fixture,
    task.id,
    scenario.initialRuntimeState,
    taskRunner,
    () => ({
      tasks: [{ id: task.id, status: taskRepository(fixture.db).getTaskById(task.id)!.status }],
      approvals: [],
      guardianDecision: guardianPassed,
      recovery: null,
      missionStatus: fixture.service.get(fixture.missionId).status,
    }),
    (missionId) => fixture.service.finalize(missionId),
  );
  return task.id;
}

async function runUserCancel(fixture: Fixture): Promise<string> {
  const task = createTask(fixture);
  const runner = runningTaskRunner(fixture.db);
  fixture.taskRunner = runner;
  activeRunners.push(runner);
  await startTask(runner, task.id);
  fixture.service.cancel(fixture.missionId);
  await settleControllerPath(
    fixture,
    task.id,
    "executing",
    runner,
    () => ({
      tasks: [{ id: task.id, status: taskRepository(fixture.db).getTaskById(task.id)!.status }],
      approvals: [],
      guardianDecision: guardianPassed,
      recovery: null,
      missionStatus: fixture.service.get(fixture.missionId).status,
      terminalOutcomeKind: "user_cancel",
      terminalOutcomeReason: "Mission cancelled by user.",
      terminalOutcomeRecorded: false,
    }),
  );
  return task.id;
}

async function runControllerExhaustion(fixture: Fixture): Promise<string> {
  const task = createTask(fixture);
  const runner = runningTaskRunner(fixture.db);
  fixture.taskRunner = runner;
  activeRunners.push(runner);
  await startTask(runner, task.id);
  await settleControllerPath(
    fixture,
    task.id,
    "recovering",
    runner,
    () => ({
      tasks: [{ id: task.id, status: taskRepository(fixture.db).getTaskById(task.id)!.status }],
      approvals: [],
      guardianDecision: guardianPassed,
      recovery: exhaustedRecovery("controller_exhausted"),
      missionStatus: fixture.service.get(fixture.missionId).status,
      terminalOutcomeKind: "controller_exhausted",
      terminalOutcomeReason: "No materially different automatic strategy remains.",
    }),
  );
  return task.id;
}

async function runMissionFailureTerminalPath(fixture: Fixture, kind: "tool_loop_exhausted" | "revision_limit"): Promise<string> {
  const task = createTask(fixture, { id: "task-1", status: "interrupted" });
  if (kind === "revision_limit") {
    const cortex = new CortexService({ repo: intelligenceRepository(fixture.db), getWorkspacePath: () => process.cwd(), now: () => now });
    fixture.service = new MissionService({
      repo: fixture.repo,
      getWorkspacePath: () => process.cwd(),
      backupDir: process.cwd(),
      cortex,
      now: () => now,
    });
    for (let revision = 0; revision < MAX_PLAN_REVISIONS; revision++) {
      cortex.recordPlanRevision(fixture.missionId, { trigger: "repeated_tool_failure", triggerDetail: "seeded conformance limit" });
    }
  }
  for (let attempt = 0; attempt < (kind === "revision_limit" ? 3 : 4); attempt++) {
    fixture.service.recordFailure(fixture.missionId, "unknown_tool same", "repeated recoverable tool failure");
  }
  const terminalKind = terminalKindFromEvents(fixture, task.id);
  expect(terminalKind).toBe(kind);

  const taskRunner: ObservableTaskRunner = { isActive: () => false, waitFor: async () => undefined };
  fixture.taskRunner = taskRunner;
  await settleControllerPath(
    fixture,
    task.id,
    "executing",
    taskRunner,
    () => ({
      tasks: [{ id: task.id, status: taskRepository(fixture.db).getTaskById(task.id)!.status }],
      approvals: [],
      guardianDecision: guardianPassed,
      recovery: exhaustedRecovery(kind),
      missionStatus: fixture.service.get(fixture.missionId).status,
      ...(terminalKind ? { terminalOutcomeKind: terminalKind } : {}),
      terminalOutcomeReason: `Worker entered ${kind}.`,
    }),
  );
  return task.id;
}

async function runFreeExecutionObservationPath(fixture: Fixture): Promise<string> {
  const conversations = conversationsRepository(fixture.db);
  conversations.createConversation({ id: "conversation-1", projectId: "project-1", title: "Free execution path", createdAt: now, updatedAt: now });
  conversations.appendMessage({ id: "message-user", conversationId: "conversation-1", role: "user", content: "go", createdAt: now, updatedAt: now });
  const task = createTask(fixture, { id: "task-1" });
  conversations.appendMessage({ id: "message-assistant", conversationId: "conversation-1", role: "assistant", content: "", taskId: task.id, streamingState: "queued", createdAt: now, updatedAt: now });
  const provider = new MockProvider({
    chunks: [
      repeatedFailureTurn(),
      repeatedFailureTurn(),
      repeatedFailureTurn(),
      repeatedFailureTurn(),
      [{ type: "text", text: "The repeated tool failures were observed; the model owns the next action." }, { type: "done" }],
    ],
  });
  await executeAgentChatTask({ db: fixture.db, taskId: task.id, provider, maxTurns: 8 });
  expect(provider.requests.length).toBe(5);
  expect(taskRepository(fixture.db).getTaskById(task.id)?.status).toBe("completed");
  expect(fixture.service.get(fixture.missionId).status).toBe("running");
  expect(terminalKindFromEvents(fixture, task.id)).toBeUndefined();
  expect(fixture.repo.listEvents(fixture.missionId).some((event) => event.type === "mission.loop_detected")).toBe(true);
  return task.id;
}

async function runStartupReconciliation(fixture: Fixture): Promise<string> {
  fixture.repo.setStatus(fixture.missionId, "blocked", now);
  fixture.repo.appendEvent(fixture.missionId, "mission.status_changed", "Status: running → blocked", { from: "running", to: "blocked" }, now);
  const task = createTask(fixture, { status: "queued" });
  const taskRunner = runningTaskRunner(fixture.db);
  fixture.taskRunner = taskRunner;
  activeRunners.push(taskRunner);
  const runtime = missionRuntimeRepository(fixture.db);
  runtime.create({ missionId: fixture.missionId, state: "blocked", now });
  fixture.db.prepare("UPDATE mission_runtime SET active_task_id=? WHERE mission_id=?").run(task.id, fixture.missionId);
  const controllerRunner = new MissionControllerRunner({
    runtime,
    controller: {} as never,
    taskRunner,
    ownerId: "conformance-startup",
    now: () => now,
    concludeTerminalOutcome: (missionId, input) => fixture.service.concludeTerminalOutcome(missionId, input),
  });
  await reconcileMissionsOnStartup({
    db: fixture.db,
    runner: taskRunner,
    controllerRunner,
    now: () => now,
  });
  return task.id;
}

describe("terminal mission outcome conformance", () => {
  const databases: Array<ReturnType<typeof openDatabase>> = [];

  afterEach(async () => {
    for (const runner of activeRunners.splice(0)) {
      runner.cancel("task-1");
      await runner.waitFor("task-1");
    }
    for (const db of databases.splice(0)) db.close();
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("declares every terminal entry path exactly once", () => {
    expect(new Set(TERMINAL_ENTRY_KINDS)).toEqual(new Set(scenarios.map((scenario) => scenario.kind)));
  });

  it.each(scenarios)("settles $kind as one terminal outcome through its production entry path", async (scenario) => {
    const fixture = createFixture();
    databases.push(fixture.db);
    let taskId: string;
    switch (scenario.kind) {
      case "normal_finalize":
        taskId = await runNormalFinalize(fixture, scenario);
        break;
      case "user_cancel":
        taskId = await runUserCancel(fixture);
        break;
      case "controller_exhausted":
        taskId = await runControllerExhaustion(fixture);
        break;
      case "tool_loop_exhausted":
      case "revision_limit":
        taskId = await runMissionFailureTerminalPath(fixture, scenario.kind);
        break;
      case "startup_reconciliation":
        taskId = await runStartupReconciliation(fixture);
        break;
    }

    const settledMission = fixture.service.get(fixture.missionId);
    const settledRuntime = missionRuntimeRepository(fixture.db).get(fixture.missionId)!;
    const settledTask = taskRepository(fixture.db).getTaskById(taskId)!;
    const events = fixture.repo.listEvents(fixture.missionId);
    expect(settledMission.status).toBe(scenario.missionStatus);
    expect(settledRuntime.state).toBe(scenario.expectedRuntimeState);
    expect(terminalDispositionForMission(settledMission.status)).toBe(scenario.expectedRuntimeState);
    expect(["completed", "failed", "cancelled", "interrupted"]).toContain(settledTask.status);
    expect(fixture.taskRunner?.isActive(taskId)).toBe(false);
    expect(events.filter((event) => event.type === "mission.conclusion_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "mission.terminal_outcome_recorded")).toHaveLength(1);
    expect(settledMission.result?.status).toBe(settledMission.status);
  });

  it("keeps repeated recoverable agent failures as observations until the model finishes", async () => {
    const fixture = createFixture();
    databases.push(fixture.db);
    await runFreeExecutionObservationPath(fixture);
  });

  it("covers controller exhaustion through the default linked-task composition", async () => {
    const fixture = createFixture();
    databases.push(fixture.db);
    const task = createTask(fixture, { id: "task-1" });
    const records = taskRecordsRepository(fixture.db);
    records.transitionTask(task.id, "running", { id: "task-1-running", createdAt: now, payload: {} });
    records.transitionTask(task.id, "interrupted", {
      id: "task-1-interrupted",
      createdAt: now,
      payload: {
        reason: "provider_recovery_required",
        message: "Provider rejected the request.",
        provider: { kind: "provider", retryable: false, status: 402, retryAfterMs: null },
      },
    });
    const runtime = missionRuntimeRepository(fixture.db);
    runtime.create({ missionId: fixture.missionId, state: "recovering", now });
    fixture.db.prepare("UPDATE mission_runtime SET active_task_id=? WHERE mission_id=?").run(task.id, fixture.missionId);
    runtime.recordRecovery({
      missionId: fixture.missionId,
      operationId: null,
      category: "process_interruption",
      diagnosis: "The linked worker exhausted its recovery strategy.",
      failedStrategyFingerprint: "worker:default-composition",
      nextStrategyFingerprint: null,
      action: "block_precisely",
      retryCondition: null,
      exhausted: true,
      now,
    });
    const taskRunner = new TaskRunner(fixture.db, async () => undefined);
    activeRunners.push(taskRunner);
    const controllerRunner = createDefaultMissionControllerRunner({
      db: fixture.db,
      taskRunner,
      env: { MORROW_HOME: process.cwd() },
      ownerId: "default-composition-conformance",
      now: () => now,
      completion: async () => ({ text: "[]" }),
    });

    expect(fixture.service.get(fixture.missionId).status).toBe("running");
    expect(runtime.get(fixture.missionId)?.state).toBe("recovering");
    expect(runtime.listRecoveryDecisions(fixture.missionId).at(-1)?.exhausted).toBe(true);

    controllerRunner.run(fixture.missionId);
    await controllerRunner.waitFor(fixture.missionId);

    const settledMission = fixture.service.get(fixture.missionId);
    const settledRuntime = runtime.get(fixture.missionId)!;
    expect(settledRuntime.state).toBe("blocked");
    expect(settledMission.status).toBe("blocked");
    expect(taskRepository(fixture.db).getTaskById(task.id)?.missionId).toBe(fixture.missionId);
    expect(taskRunner.isActive(task.id)).toBe(false);
    expect(fixture.repo.listEvents(fixture.missionId).filter((event) => event.type === "mission.terminal_outcome_recorded")).toHaveLength(1);
  });
});
