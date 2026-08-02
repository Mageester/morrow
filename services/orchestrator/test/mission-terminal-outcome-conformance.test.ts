import { afterEach, describe, expect, it } from "vitest";
import type { MissionRuntimeState, MissionStatus, TaskStatus } from "@morrow/contracts";
import { openDatabase } from "../src/database.js";
import { terminalDispositionForMission, TERMINAL_ENTRY_KINDS, type TerminalEntryKind } from "../src/mission/terminal-outcome.js";
import { MissionService } from "../src/mission/service.js";
import { MissionControllerRunner } from "../src/mission/controller-runner.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
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
  { kind: "tool_loop_exhausted", missionStatus: "blocked", initialRuntimeState: "executing", expectedRuntimeState: "blocked", taskStatus: "running" },
  { kind: "revision_limit", missionStatus: "blocked", initialRuntimeState: "recovering", expectedRuntimeState: "blocked", taskStatus: "interrupted" },
  { kind: "startup_reconciliation", missionStatus: "blocked", initialRuntimeState: "recovering", expectedRuntimeState: "blocked", taskStatus: "queued" },
];

describe("terminal mission outcome conformance", () => {
  const databases: Array<ReturnType<typeof openDatabase>> = [];
  const runners: TaskRunner[] = [];
  const now = "2026-08-02T12:00:00.000Z";

  afterEach(async () => {
    for (const runner of runners.splice(0)) {
      runner.cancel("task-1");
      await runner.waitFor("task-1");
    }
    for (const db of databases.splice(0)) db.close();
  });

  it("declares every terminal entry path exactly once", () => {
    expect(new Set(TERMINAL_ENTRY_KINDS)).toEqual(new Set(scenarios.map((scenario) => scenario.kind)));
  });

  it.each(scenarios)("settles $kind as one terminal outcome", async (scenario) => {
    const db = openDatabase(":memory:");
    databases.push(db);
    projectRepository(db).createProject({
      id: "project-1",
      name: "Project",
      workspacePath: process.cwd(),
      createdAt: now,
    });
    const repo = missionsRepository(db);
    const service = new MissionService({
      repo,
      getWorkspacePath: () => process.cwd(),
      backupDir: process.cwd(),
      now: () => now,
    });
    const mission = service.create("project-1", { objective: "Complete the work", autoApprove: true });
    service.approveCriteria(mission.id);
    if (scenario.missionStatus === "cancelled") {
      service.cancel(mission.id);
    } else if (scenario.missionStatus !== "running") {
      repo.setStatus(mission.id, scenario.missionStatus, now);
      repo.appendEvent(mission.id, "mission.status_changed", `Status: running → ${scenario.missionStatus}`, { from: "running", to: scenario.missionStatus }, now);
    }

    const task = taskRepository(db).createTask({
      id: "task-1",
      projectId: "project-1",
      missionId: mission.id,
      kind: "agent_chat",
      status: scenario.taskStatus,
      createdAt: now,
    });
    const records = taskRecordsRepository(db);
    const taskRunner = new TaskRunner(db, async ({ abortSignal }) => {
      records.transitionTask(task.id, "running", { id: "task-running", createdAt: now, payload: {} });
      await new Promise<void>((resolve) => abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    runners.push(taskRunner);
    if (scenario.taskStatus === "running") {
      taskRunner.run(task.id);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const runtime = missionRuntimeRepository(db);
    runtime.create({ missionId: mission.id, state: scenario.initialRuntimeState, now });
    db.prepare("UPDATE mission_runtime SET active_task_id=? WHERE mission_id=?").run(task.id, mission.id);
    const controllerRuntime = runtime.get(mission.id)!;
    const controller = {
      tick: async () => ({
        runtime: controllerRuntime,
        action: `terminal:${scenario.kind}`,
        immediate: true,
        waitingForExternal: false,
        terminalOutcome: {
          kind: scenario.kind,
          reason: `Terminal entry: ${scenario.kind}`,
          preserveStatus: scenario.missionStatus,
        },
      }),
    };
    const controllerRunner = new MissionControllerRunner({
      runtime,
      controller: controller as never,
      taskRunner,
      ownerId: "controller-test",
      now: () => now,
      concludeTerminalOutcome: (missionId, input) => service.concludeTerminalOutcome(missionId, input),
    });

    controllerRunner.run(mission.id);
    await controllerRunner.waitFor(mission.id);

    const settledMission = service.get(mission.id);
    const settledRuntime = runtime.get(mission.id)!;
    const settledTask = taskRepository(db).getTaskById(task.id)!;
    const events = repo.listEvents(mission.id);
    expect(settledMission.status).toBe(scenario.missionStatus);
    expect(settledRuntime.state).toBe(scenario.expectedRuntimeState);
    expect(terminalDispositionForMission(settledMission.status)).toBe(scenario.expectedRuntimeState);
    expect(["completed", "failed", "cancelled", "interrupted"]).toContain(settledTask.status);
    expect(taskRunner.isActive(task.id)).toBe(false);
    expect(events.filter((event) => event.type === "mission.conclusion_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "mission.terminal_outcome_recorded")).toHaveLength(1);
    expect(settledMission.result?.status).toBe(settledMission.status);
  });
});
