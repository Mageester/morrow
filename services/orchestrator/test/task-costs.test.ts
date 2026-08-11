import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CostLineSchema, type CostLine, type PricingSnapshot } from "@morrow/contracts";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskCostsRepository } from "../src/repositories/task-costs.js";

const createdAt = "2026-08-11T00:00:00.000Z";
const later = "2026-08-11T00:00:01.000Z";

const pricing: PricingSnapshot = {
  inputMicrosPerMillion: 140_000,
  outputMicrosPerMillion: 280_000,
  cachedInputMicrosPerMillion: 2_800,
  source: "authoritative",
  metadataVersion: "catalog-v1",
  fetchedAt: createdAt,
};

function line(overrides: Partial<CostLine> = {}): CostLine {
  return CostLineSchema.parse({
    id: "line-1",
    taskId: "agent-task",
    requestId: "request-1",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 500_000,
    amount: { currency: "USD", micros: 280_000 },
    accuracy: "exact_usage_pricing",
    pricing,
    recordedAt: createdAt,
    ...overrides,
  });
}

function setup(file = ":memory:") {
  const db = openDatabase(file);
  projectRepository(db).createProject({ id: "project", name: "Project", workspacePath: "C:/workspace", createdAt });
  taskRepository(db).createTask({ id: "agent-task", projectId: "project", kind: "agent_chat", status: "queued", createdAt });
  taskRepository(db).createTask({ id: "local-task", projectId: "project", kind: "inspect_workspace", status: "queued", createdAt });
  return { db, costs: taskCostsRepository(db), records: taskRecordsRepository(db) };
}

describe("task cost repository", () => {
  it("persists a frozen pricing snapshot and ignores a replay with the same task request identity", () => {
    const { db, costs } = setup();

    const original = line();
    const replay = line({
      id: "replayed-line",
      amount: { currency: "USD", micros: 999_999 },
      pricing: { ...pricing, metadataVersion: "catalog-v2", inputMicrosPerMillion: 999_999 },
      recordedAt: later,
    });

    expect(costs.record(original)).toEqual(original);
    expect(costs.record(replay)).toEqual(original);
    expect(costs.get("agent-task", "request-1")).toEqual(original);
    expect(costs.get("line-1")).toEqual(original);
    expect(costs.summaryByTask("agent-task")).toMatchObject({
      total: { currency: "USD", micros: 280_000 },
      requestCount: 1,
      accuracy: "exact_usage_pricing",
    });

    db.close();
  });

  it("rehydrates ordered cost lines and exact totals after reopening the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-task-costs-"));
    const file = join(directory, "costs.db");
    const initial = setup(file);
    initial.costs.record(line());
    initial.db.close();

    const reopened = openDatabase(file);
    const costs = taskCostsRepository(reopened);
    expect(costs.listByTask("agent-task")).toEqual([line()]);
    expect(costs.summaryByTask("agent-task").total).toEqual({ currency: "USD", micros: 280_000 });
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps fallback and unknown attempts visible while withholding a partial total", () => {
    const { db, costs } = setup();
    costs.record(line());
    costs.record(line({
      id: "line-fallback",
      requestId: "request-fallback",
      providerId: "fallback",
      modelId: "fallback-model",
      inputTokens: 500,
      cachedInputTokens: null,
      outputTokens: 5,
      amount: { currency: "USD", micros: 10 },
      accuracy: "exact_usage_pricing",
      pricing: { ...pricing, cachedInputMicrosPerMillion: null },
      recordedAt: later,
    }));
    costs.record(line({
      id: "line-unknown",
      requestId: "request-unknown",
      providerId: "failed-provider",
      modelId: "failed-model",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      amount: null,
      accuracy: "unknown",
      pricing: null,
      recordedAt: "2026-08-11T00:00:02.000Z",
    }));

    const summary = costs.summaryByTask("agent-task");
    expect(summary).toMatchObject({
      total: null,
      accuracy: "unknown",
      requestCount: 3,
      totalInputTokens: 1_000_500,
      knownFreshInputTokens: 1_000_000,
      knownCachedInputTokens: 0,
      outputTokens: 500_005,
      cacheBreakdownComplete: false,
    });
    expect(summary.lines.map((item) => item.requestId)).toEqual(["request-1", "request-fallback", "request-unknown"]);
    expect(summary.lines[0]?.amount).toEqual({ currency: "USD", micros: 280_000 });
    expect(summary.lines[1]?.amount).toEqual({ currency: "USD", micros: 10 });
    expect(summary.lines[2]?.amount).toBeNull();

    db.close();
  });

  it("returns an unknown empty summary unless the task is explicitly deterministic-local", () => {
    const { db, costs, records } = setup();

    expect(costs.summaryByTask("agent-task")).toMatchObject({
      total: null,
      accuracy: "unknown",
      requestCount: 0,
      lines: [],
    });

    records.upsertDisclosure({
      taskId: "local-task",
      executionMode: "deterministic-local",
      provider: "deterministic-local",
      networkAccess: "disabled",
      filesystemAccess: "read-only",
      shellExecution: false,
      modelInvocation: false,
      workspaceScope: "C:/workspace",
      estimatedCostUsd: "$0.00",
      createdAt,
      updatedAt: createdAt,
    });
    expect(costs.summaryByTask("local-task")).toMatchObject({
      total: { currency: "USD", micros: 0 },
      accuracy: "exact_usage_pricing",
      requestCount: 0,
      lines: [],
    });
    expect(records.getAggregate("local-task").cost).toMatchObject({
      total: { currency: "USD", micros: 0 },
      accuracy: "exact_usage_pricing",
    });

    db.close();
  });
});
