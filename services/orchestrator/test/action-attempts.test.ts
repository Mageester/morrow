import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import {
  actionAttemptsRepository,
  actionEnvironmentFingerprint,
  normalizeActionSignature,
} from "../src/repositories/action-attempts.js";

describe("durable action attempts", () => {
  let db: Database.Database;
  const now = "2026-07-26T17:00:00.000Z";

  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({
      id: "project-1",
      name: "Attempts",
      workspacePath: "C:/workspace",
      createdAt: now,
    });
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project-1", "Repair project", "running", 1, "{}", now, now);
    taskRepository(db).createTask({
      id: "task-1",
      projectId: "project-1",
      missionId: "mission-1",
      kind: "agent_chat",
      status: "queued",
      createdAt: now,
    });
  });

  afterEach(() => db.close());

  it("normalizes semantically equivalent package verification commands", () => {
    const first = normalizeActionSignature("run_command", {
      executable: "PNPM.CMD",
      args: ["run", "test"],
      cwd: ".",
      purpose: "Run suite",
    });
    const second = normalizeActionSignature("run_command", {
      executable: "pnpm",
      args: [" test "],
      cwd: "",
      purpose: "Try again",
    });
    const otherDirectory = normalizeActionSignature("run_command", {
      executable: "pnpm",
      args: ["test"],
      cwd: "packages/ui",
    });

    expect(first).toBe(second);
    expect(otherDirectory).not.toBe(first);
  });

  it("keeps intentional exit-code assertions distinct for retry decisions", () => {
    const expectedFailure = normalizeActionSignature("run_command", {
      executable: "node",
      args: ["fixture.mjs"],
      expectedExitCode: 1,
    });
    const expectedSuccess = normalizeActionSignature("run_command", {
      executable: "node",
      args: ["fixture.mjs"],
      expectedExitCode: 0,
    });
    expect(expectedFailure).not.toBe(expectedSuccess);
    expect(normalizeActionSignature("run_command", {
      executable: "node",
      args: ["fixture.mjs"],
    })).toBe(expectedSuccess);
  });

  it("fingerprints only execution-relevant allowlisted environment values", () => {
    const first = actionEnvironmentFingerprint({
      PATH: "C:/tools",
      TEMP: "C:/temp",
      SECRET_API_KEY: "first-secret",
    });
    const secretChanged = actionEnvironmentFingerprint({
      PATH: "C:/tools",
      TEMP: "C:/temp",
      SECRET_API_KEY: "second-secret",
    });
    const pathChanged = actionEnvironmentFingerprint({
      PATH: "C:/other-tools",
      TEMP: "C:/temp",
      SECRET_API_KEY: "first-secret",
    });

    expect(first).toBe(secretChanged);
    expect(pathChanged).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists attempt numbers, failure outcome, and suppression across task restart", () => {
    const repo = actionAttemptsRepository(db);
    const signature = normalizeActionSignature("run_command", {
      executable: "pnpm",
      args: ["test"],
      cwd: "",
    });
    const environmentFingerprint = actionEnvironmentFingerprint({ PATH: "C:/tools" });

    const first = repo.start({
      id: "attempt-1",
      taskId: "task-1",
      missionId: "mission-1",
      toolCallId: "tool-1",
      actionKind: "run_command",
      normalizedSignature: signature,
      command: { executable: "pnpm", args: ["test"] },
      cwd: "",
      environmentFingerprint,
      strategy: "worker:mock:model-a",
      createdAt: now,
    });
    repo.finish(first.id, {
      status: "failed",
      exitStatus: 1,
      terminationReason: "completed",
      failureCategory: "test_failure",
      failureFingerprint: "test_failure:assertion",
      progressFingerprint: null,
      completedAt: "2026-07-26T17:00:01.000Z",
    });

    const second = repo.start({
      id: "attempt-2",
      taskId: "task-1",
      missionId: "mission-1",
      toolCallId: "tool-2",
      actionKind: "run_command",
      normalizedSignature: signature,
      command: { executable: "pnpm", args: ["test"] },
      cwd: "",
      environmentFingerprint,
      strategy: "worker:mock:model-a",
      createdAt: "2026-07-26T17:00:02.000Z",
    });
    repo.finish(second.id, {
      status: "failed",
      exitStatus: 1,
      terminationReason: "completed",
      failureCategory: "test_failure",
      failureFingerprint: "test_failure:assertion",
      progressFingerprint: null,
      completedAt: "2026-07-26T17:00:03.000Z",
    });

    expect(first.attemptNumber).toBe(1);
    expect(second.attemptNumber).toBe(2);
    expect(repo.shouldSuppress("task-1", "mission-1", signature)).toMatchObject({
      suppress: true,
      failedAttempts: 2,
      reason: expect.stringMatching(/meaningful change/i),
    });
    expect(repo.listForTask("task-1")).toEqual([
      expect.objectContaining({
        id: "attempt-1",
        status: "failed",
        exitStatus: 1,
        failureCategory: "test_failure",
      }),
      expect.objectContaining({
        id: "attempt-2",
        status: "failed",
        attemptNumber: 2,
      }),
    ]);
  });

  it("detects two-strategy oscillation and clears suppression after real progress", () => {
    const repo = actionAttemptsRepository(db);
    const environmentFingerprint = actionEnvironmentFingerprint({ PATH: "C:/tools" });
    const signatures = ["strategy-a", "strategy-b", "strategy-a", "strategy-b"];

    signatures.forEach((signature, index) => {
      const attempt = repo.start({
        id: `attempt-${index}`,
        taskId: "task-1",
        missionId: "mission-1",
        toolCallId: `tool-${index}`,
        actionKind: "run_command",
        normalizedSignature: signature,
        command: { executable: "node", args: [signature] },
        cwd: "",
        environmentFingerprint,
        strategy: signature,
        createdAt: `2026-07-26T17:00:0${index}.000Z`,
      });
      repo.finish(attempt.id, {
        status: "failed",
        exitStatus: 1,
        terminationReason: "completed",
        failureCategory: "tool_error",
        failureFingerprint: `tool_error:${signature}`,
        progressFingerprint: null,
        completedAt: `2026-07-26T17:00:1${index}.000Z`,
      });
    });

    expect(repo.detectOscillation("task-1", "mission-1")).toEqual({
      oscillating: true,
      signatures: ["strategy-a", "strategy-b"],
    });

    const recovered = repo.start({
      id: "attempt-success",
      taskId: "task-1",
      missionId: "mission-1",
      toolCallId: "tool-success",
      actionKind: "run_command",
      normalizedSignature: "strategy-b",
      command: { executable: "node", args: ["strategy-b"] },
      cwd: "",
      environmentFingerprint,
      strategy: "strategy-b",
      createdAt: "2026-07-26T17:01:00.000Z",
    });
    repo.finish(recovered.id, {
      status: "succeeded",
      exitStatus: 0,
      terminationReason: "completed",
      failureCategory: null,
      failureFingerprint: null,
      progressFingerprint: "diff:new",
      completedAt: "2026-07-26T17:01:01.000Z",
    });

    expect(repo.shouldSuppress("task-1", "mission-1", "strategy-b").suppress).toBe(false);
  });
});
