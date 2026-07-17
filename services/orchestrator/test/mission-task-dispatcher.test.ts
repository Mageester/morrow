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

  it("resolves the serving provider for a model-only selection instead of stamping it on preset routing", () => {
    const env = {
      ...process.env,
      MOCK_PROVIDER: undefined,
      OPENAI_COMPAT_BASE_URL: "https://opencode.ai/v1",
      OPENAI_COMPAT_MODEL: "deepseek-v4-flash-free",
    } as NodeJS.ProcessEnv;
    const result = dispatchAgentTask({ db, runner: { run }, env }, {
      conversationId: "conversation-1",
      content: "Build the thing",
      model: "deepseek-v4-flash-free",
      mode: "agent",
    });
    expect(result.routing).toMatchObject({
      providerId: "openai-compatible",
      model: "deepseek-v4-flash-free",
    });
    expect(result.assistantMessage).toMatchObject({ provider: "openai-compatible", model: "deepseek-v4-flash-free" });
  });

  it("rejects a model-only selection that no configured provider serves, before any execution", () => {
    const env = { ...process.env, MOCK_PROVIDER: undefined, OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv;
    expect(() => dispatchAgentTask({ db, runner: { run }, env }, {
      conversationId: "conversation-1",
      content: "Build the thing",
      model: "model-nobody-serves",
      mode: "agent",
    })).toThrow(AgentTaskDispatchError);
    try {
      dispatchAgentTask({ db, runner: { run }, env }, {
        conversationId: "conversation-1",
        content: "Build the thing",
        model: "model-nobody-serves",
        mode: "agent",
      });
    } catch (error) {
      expect((error as AgentTaskDispatchError).code).toBe("MODEL_UNROUTABLE");
      expect((error as AgentTaskDispatchError).statusCode).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
    expect(taskRepository(db).listTasksByProject("project-1")).toHaveLength(0);
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
