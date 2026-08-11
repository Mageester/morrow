import type { TaskCostSummary } from "@morrow/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatUsdMicros, taskCostQueries } from "./task-cost.js";

const summary: TaskCostSummary = {
  taskId: "task-1",
  total: { currency: "USD", micros: 12_300 },
  accuracy: "exact_usage_pricing",
  requestCount: 1,
  totalInputTokens: 12_000,
  knownFreshInputTokens: 8_000,
  knownCachedInputTokens: 4_000,
  outputTokens: 800,
  cacheBreakdownComplete: true,
  lines: [{
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
      metadataVersion: "catalog-1",
      fetchedAt: "2026-08-11T12:00:00.000Z",
    },
    recordedAt: "2026-08-11T12:00:00.000Z",
  }],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("task cost browser API", () => {
  it("formats fixed-point micro-USD without losing sub-cent task amounts", () => {
    expect(formatUsdMicros({ currency: "USD", micros: 12_300 })).toBe("$0.0123");
    expect(formatUsdMicros({ currency: "USD", micros: 0 })).toBe("$0.0000");
    expect(formatUsdMicros(null)).toBe("Unknown");
  });

  it("uses the task query-key convention and validates the browser-safe summary", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/tasks/task%2F1/cost");
      return Response.json(summary);
    });
    vi.stubGlobal("fetch", fetchMock);

    const query = taskCostQueries.forTask("task/1");
    expect(query.queryKey).toEqual(["task", "task/1", "cost"]);
    await expect(new QueryClient().fetchQuery(query)).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
