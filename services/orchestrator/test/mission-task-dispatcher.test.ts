import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import {
  AgentTaskDispatchError,
  dispatchAgentTask,
} from "../src/mission/task-dispatcher.js";

describe("mission agent-task dispatcher", () => {
  let db: ReturnType<typeof openDatabase>;
  let run: ReturnType<typeof vi.fn<(taskId: string) => void>>;
  let previousMockProvider: string | undefined;

  beforeEach(() => {
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    run = vi.fn<(taskId: string) => void>();
    const now = "2026-07-16T12:00:00.000Z";
    projectRepository(db).createProject({
      id: "project-1",
      name: "Project",
      workspacePath: "/workspace",
      createdAt: now,
    });
    conversationsRepository(db).createConversation({
      id: "conversation-1",
      projectId: "project-1",
      title: "Mission",
      createdAt: now,
      updatedAt: now,
    });
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-1", 1, "project-1", "Durable work", "running", 1, "{}", now, now);
  });

  afterEach(() => {
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
    db.close();
  });

  it("replays one idempotent mission dispatch without invoking the runner twice", () => {
    const request = {
      conversationId: "conversation-1",
      content: "Continue requirement 1",
      missionId: "mission-1",
      idempotencyKey: "mission:m1:op:o1",
      mode: "agent" as const,
    };

    const first = dispatchAgentTask({ db, runner: { run }, env: process.env }, request);
    const second = dispatchAgentTask({ db, runner: { run }, env: process.env }, request);

    expect(second.replayed).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(second.userMessage?.id).toBe(first.userMessage?.id);
    expect(second.assistantMessage?.id).toBe(first.assistantMessage?.id);
    expect(second.routing?.providerId).toBe("mock");
    expect(run).toHaveBeenCalledTimes(1);
    expect(taskRepository(db).listTasksByProject("project-1")).toHaveLength(1);
    expect(conversationsRepository(db).listMessages("conversation-1")).toHaveLength(2);
  });

  it("persists the exact routing and execution policy before dispatch", () => {
    const result = dispatchAgentTask({ db, runner: { run }, env: process.env }, {
      conversationId: "conversation-1",
      content: "Plan only",
      idempotencyKey: "mission:m1:op:o2",
      missionId: "mission-1",
      mode: "plan-only",
      useMemory: false,
      reasoning: { mode: "auto" },
    });

    expect(result.routing).toMatchObject({
      providerId: "mock",
      model: "mock-model",
      mode: "plan-only",
      toolProfile: "none",
      autoApprove: false,
      reasoning: { mode: "auto" },
    });
    expect(result.assistantMessage).toMatchObject({ provider: "mock", model: "mock-model" });
    const stored = db.prepare("SELECT use_memory,decision_json FROM task_routing WHERE task_id=?")
      .get(result.task.id) as { use_memory: number; decision_json: string };
    expect(stored.use_memory).toBe(0);
    expect(JSON.parse(stored.decision_json)).toEqual(result.routing);
    expect(run).toHaveBeenCalledWith(result.task.id);
  });

  it("rejects an idempotency key reused for different content", () => {
    const base = {
      conversationId: "conversation-1",
      content: "Original operation",
      missionId: "mission-1",
      idempotencyKey: "mission:m1:op:immutable",
    };
    dispatchAgentTask({ db, runner: { run }, env: process.env }, base);

    expect(() => dispatchAgentTask({ db, runner: { run }, env: process.env }, {
      ...base,
      content: "Different operation",
    })).toThrow(/different request/i);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects replay when any canonical execution input changes", () => {
    const base = {
      conversationId: "conversation-1",
      content: "Immutable execution request",
      missionId: "mission-1",
      idempotencyKey: "mission:m1:op:full-fingerprint",
      mode: "read-only" as const,
      preset: "balanced" as const,
      reasoning: { mode: "auto" as const },
      useMemory: true,
      autoApprove: false,
    };
    dispatchAgentTask({ db, runner: { run }, env: process.env }, base);

    const conflicts = [
      { label: "Ask to Build mode", request: { ...base, mode: "agent" as const } },
      { label: "preset", request: { ...base, preset: "fast" as const } },
      { label: "provider", request: { ...base, providerId: "openai" as const } },
      { label: "model", request: { ...base, model: "different-model" } },
      { label: "reasoning", request: { ...base, reasoning: { mode: "effort" as const, effort: "high" as const } } },
      { label: "memory", request: { ...base, useMemory: false } },
      { label: "approval", request: { ...base, autoApprove: true } },
    ];
    for (const conflict of conflicts) {
      expect(
        () => dispatchAgentTask({ db, runner: { run }, env: process.env }, conflict.request),
        conflict.label,
      ).toThrow(/different request/i);
    }
    expect(run).toHaveBeenCalledTimes(1);
    expect(taskRepository(db).listTasksByProject("project-1")).toHaveLength(1);
  });

  it("rolls back the entire dispatch bundle and never starts the runner when a late insert fails", () => {
    const ids = ["task-atomic", "message-duplicate", "state-id", "message-duplicate"];
    expect(() => dispatchAgentTask({
      db,
      runner: { run },
      env: process.env,
      createId: () => ids.shift() ?? "unexpected-id",
    }, {
      conversationId: "conversation-1",
      content: "Atomic or absent",
      idempotencyKey: "atomic-failure",
      mode: "read-only",
    })).toThrow();

    expect(taskRepository(db).listTasksByProject("project-1")).toHaveLength(0);
    expect(conversationsRepository(db).listMessages("conversation-1")).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM task_routing").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM agent_state_transitions").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM task_events").get() as { count: number }).count).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("never replays a legacy partial idempotency row without its committed bundle", () => {
    taskRepository(db).createTask({
      id: "partial-task",
      projectId: "project-1",
      kind: "agent_chat",
      status: "queued",
      idempotencyKey: "partial-bundle",
      createdAt: "2026-07-16T12:00:00.000Z",
    });

    let replayError: unknown;
    try {
      dispatchAgentTask({ db, runner: { run }, env: process.env }, {
        conversationId: "conversation-1",
        content: "Missing persisted bundle",
        idempotencyKey: "partial-bundle",
      });
    } catch (error) {
      replayError = error;
    }
    expect(replayError).toMatchObject({ code: "IDEMPOTENCY_INCOMPLETE" });
    expect(run).not.toHaveBeenCalled();
  });

  it("never replays a complete legacy bundle without its canonical fingerprint", () => {
    const request = {
      conversationId: "conversation-1",
      content: "Complete legacy operation",
      missionId: "mission-1",
      idempotencyKey: "legacy-complete-bundle",
      mode: "agent" as const,
      useMemory: true,
      autoApprove: false,
    };
    const created = dispatchAgentTask({ db, runner: { run }, env: process.env }, request);
    db.prepare("UPDATE tasks SET idempotency_fingerprint=NULL WHERE id=?").run(created.task.id);
    run.mockClear();

    for (const replay of [request, { ...request, mode: "read-only" as const }]) {
      let replayError: unknown;
      try {
        dispatchAgentTask({ db, runner: { run }, env: process.env }, replay);
      } catch (error) {
        replayError = error;
      }
      expect(replayError).toMatchObject({ code: "IDEMPOTENCY_INCOMPLETE" });
    }
    expect(run).not.toHaveBeenCalled();
    expect(conversationsRepository(db).listMessages("conversation-1")).toHaveLength(2);
  });

  it("rejects a mission owned by another project before creating a task", () => {
    const now = "2026-07-16T12:00:00.000Z";
    projectRepository(db).createProject({
      id: "project-2",
      name: "Other",
      workspacePath: "/other",
      createdAt: now,
    });
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("mission-2", 1, "project-2", "Other work", "running", 1, "{}", now, now);

    expect(() => dispatchAgentTask({ db, runner: { run }, env: process.env }, {
      conversationId: "conversation-1",
      content: "Cross the boundary",
      missionId: "mission-2",
      idempotencyKey: "mission:m2:op:o1",
    })).toThrow(AgentTaskDispatchError);
    expect(taskRepository(db).listTasksByProject("project-1")).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });
});
