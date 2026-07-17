import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { createDefaultMissionControllerRunner } from "../src/mission/controller-runner.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRepository } from "../src/repositories/tasks.js";

describe("production durable mission controller composition", () => {
  const databases: Array<ReturnType<typeof openDatabase>> = [];
  afterEach(() => databases.splice(0).forEach((db) => db.close()));

  it("dispatches the persisted model route and blocks one non-retryable provider failure", async () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const now = "2026-07-17T02:00:00.000Z";
    projectRepository(db).createProject({
      id: "project-1",
      name: "Project",
      workspacePath: process.cwd(),
      createdAt: now,
    });
    missionsRepository(db).create({
      id: "mission-1",
      projectId: "project-1",
      objective: "Repair receipts",
      autoApprove: true,
      budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 },
      execution: {
        preset: "coding",
        providerId: "deepseek",
        model: "deepseek-v4-pro",
        reasoning: { mode: "auto" },
      },
    }, now);
    db.prepare("UPDATE missions SET status='running', started_at=? WHERE id='mission-1'").run(now);
    missionRuntimeRepository(db).create({ missionId: "mission-1", now });
    const run = vi.fn<(taskId: string) => void>();
    const taskRunner = {
      run,
      isActive: () => false,
      waitFor: async () => undefined,
      cancel: vi.fn(),
      onSettled: () => () => undefined,
    };
    const controllerRunner = createDefaultMissionControllerRunner({
      db,
      taskRunner,
      env: {
        DEEPSEEK_API_KEY: "configured-for-routing-only",
        OPENAI_API_KEY: "configured-alternate-must-not-override-explicit-route",
      },
      ownerId: "controller-test",
      now: () => now,
    });

    controllerRunner.run("mission-1");
    await controllerRunner.waitFor("mission-1");

    const [task] = taskRepository(db).listTasksByProject("project-1");
    expect(task).toBeDefined();
    const route = db.prepare("SELECT preset_id,provider_id,model,decision_json FROM task_routing WHERE task_id=?")
      .get(task!.id) as { preset_id: string; provider_id: string; model: string; decision_json: string };
    expect(route).toMatchObject({ preset_id: "coding", provider_id: "deepseek", model: "deepseek-v4-pro" });
    expect(JSON.parse(route.decision_json)).toMatchObject({
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      overridden: true,
      reasoning: { mode: "auto" },
    });
    expect(run).toHaveBeenCalledTimes(1);

    const records = taskRecordsRepository(db);
    records.transitionTask(task!.id, "running", { id: "running", createdAt: now, payload: {} });
    records.transitionTask(task!.id, "interrupted", {
      id: "interrupted",
      createdAt: now,
      payload: {
        reason: "provider_recovery_required",
        message: "Insufficient Balance",
        provider: { kind: "provider", retryable: false, status: 402, retryAfterMs: null },
      },
    });
    controllerRunner.wake("mission-1");
    await controllerRunner.waitFor("mission-1");

    expect(missionRuntimeRepository(db).get("mission-1")?.state).toBe("blocked");
    expect(taskRepository(db).listTasksByProject("project-1")).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(missionRuntimeRepository(db).listRecoveryDecisions("mission-1")).toContainEqual(expect.objectContaining({
      category: "provider_failure",
      action: "block_precisely",
      exhausted: true,
    }));
  });
});
