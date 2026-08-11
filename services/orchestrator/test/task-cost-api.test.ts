import { TaskCostSummarySchema, type CostLine } from "@morrow/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskCostsRepository } from "../src/repositories/task-costs.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { TaskRunner } from "../src/runner.js";

const recordedAt = "2026-08-11T12:00:00.000Z";

function costLine(overrides: Partial<CostLine> = {}): CostLine {
  return {
    id: "line-1",
    taskId: "task-1",
    requestId: "request-1",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    inputTokens: 12_000,
    cachedInputTokens: 4_000,
    outputTokens: 800,
    amount: { currency: "USD", micros: 12_300 },
    accuracy: "exact_usage_pricing",
    pricing: {
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 2_000_000,
      cachedInputMicrosPerMillion: 250_000,
      source: "authoritative",
      metadataVersion: "catalog-2026-08-11",
      fetchedAt: recordedAt,
    },
    recordedAt,
    ...overrides,
  };
}

describe("GET /api/tasks/:taskId/cost", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    const projects = projectRepository(db);
    projects.createProject({ id: "project-1", name: "Project One", workspacePath: process.cwd(), createdAt: recordedAt });
    projects.createProject({ id: "project-2", name: "Project Two", workspacePath: process.cwd(), createdAt: recordedAt });
    taskRepository(db).createTask({ id: "task-1", projectId: "project-1", kind: "agent_chat", status: "completed", createdAt: recordedAt });
    taskRepository(db).createTask({ id: "task-foreign", projectId: "project-2", kind: "agent_chat", status: "completed", createdAt: recordedAt });
    taskCostsRepository(db).record(costLine());
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("returns the validated ordered summary without raw task or provider data", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tasks/task-1/cost" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(TaskCostSummarySchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      taskId: "task-1",
      total: { currency: "USD", micros: 12_300 },
      accuracy: "exact_usage_pricing",
      requestCount: 1,
      totalInputTokens: 12_000,
      knownFreshInputTokens: 8_000,
      knownCachedInputTokens: 4_000,
      outputTokens: 800,
      cacheBreakdownComplete: true,
      lines: [{ requestId: "request-1", providerId: "openai", modelId: "gpt-5.6-sol" }],
    });
    expect(body).not.toHaveProperty("events");
    expect(body).not.toHaveProperty("toolCalls");
    expect(JSON.stringify(body)).not.toContain("provider continuation");
    expect(JSON.stringify(body)).not.toContain("sk-live-secret");
  });

  it("keeps task lookup on the existing opaque task route and rejects unknown or project-scoped guesses", async () => {
    const unknown = await app.inject({ method: "GET", url: "/api/tasks/guessed-task/cost" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("NOT_FOUND");

    const projectScopedGuess = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/tasks/task-foreign/cost",
    });
    expect(projectScopedGuess.statusCode).toBe(404);
  });

  it("returns an unknown total when a task has no known cost", async () => {
    const tasks = taskRepository(db);
    tasks.createTask({ id: "task-unknown", projectId: "project-1", kind: "agent_chat", status: "running", createdAt: recordedAt });

    const response = await app.inject({ method: "GET", url: "/api/tasks/task-unknown/cost" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskId: "task-unknown",
      total: null,
      accuracy: "unknown",
      requestCount: 0,
      lines: [],
    });
  });
});
