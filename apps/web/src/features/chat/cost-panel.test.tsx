import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskCostSummary } from "@morrow/contracts";
import { taskCostQueries } from "../../api/task-cost.js";
import { CostPanel } from "./cost-panel.js";

const exactSummary: TaskCostSummary = {
  taskId: "task-1",
  total: { currency: "USD", micros: 12_300 },
  accuracy: "exact_usage_pricing",
  requestCount: 2,
  totalInputTokens: 12_000,
  knownFreshInputTokens: 8_000,
  knownCachedInputTokens: 4_000,
  outputTokens: 800,
  cacheBreakdownComplete: true,
  lines: [
    {
      id: "line-1",
      taskId: "task-1",
      requestId: "request-1",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      inputTokens: 8_000,
      cachedInputTokens: 2_000,
      outputTokens: 400,
      amount: { currency: "USD", micros: 7_000 },
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
    },
    {
      id: "line-2",
      taskId: "task-1",
      requestId: "request-2",
      providerId: "fallback",
      modelId: "fallback-model",
      inputTokens: 4_000,
      cachedInputTokens: 2_000,
      outputTokens: 400,
      amount: { currency: "USD", micros: 5_300 },
      accuracy: "exact_usage_pricing",
      pricing: {
        inputMicrosPerMillion: 1_000_000,
        outputMicrosPerMillion: 2_000_000,
        cachedInputMicrosPerMillion: 250_000,
        source: "authoritative",
        metadataVersion: "catalog-1",
        fetchedAt: "2026-08-11T12:00:00.000Z",
      },
      recordedAt: "2026-08-11T12:00:01.000Z",
    },
  ],
};

const zeroSummary: TaskCostSummary = {
  taskId: "local-task",
  total: { currency: "USD", micros: 0 },
  accuracy: "exact_usage_pricing",
  requestCount: 0,
  totalInputTokens: 0,
  knownFreshInputTokens: 0,
  knownCachedInputTokens: 0,
  outputTokens: 0,
  cacheBreakdownComplete: true,
  lines: [],
};

const unknownSummary: TaskCostSummary = {
  ...zeroSummary,
  taskId: "unknown-task",
  total: null,
  accuracy: "unknown",
  cacheBreakdownComplete: false,
};

function renderPanel(summary: TaskCostSummary, taskId = summary.taskId, compact = false) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(`/api/tasks/${encodeURIComponent(taskId)}/cost`);
    return Response.json(summary);
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CostPanel compact={compact} taskId={taskId} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CostPanel", () => {
  it("shows exact totals, token breakdown, provider models, and expandable fallback lines", async () => {
    renderPanel(exactSummary);

    const panel = await screen.findByRole("region", { name: "Task cost" });
    expect(await within(panel).findByText("$0.0123")).toBeVisible();
    expect(within(panel).getByText(/Exact usage cost: \$0\.0123 USD; provider invoice amount not available/)).toBeVisible();
    expect(within(panel).getByText("Input: 12,000 tokens")).toBeVisible();
    expect(within(panel).getByText("Cached input: 4,000 tokens")).toBeVisible();
    expect(within(panel).getByText("Output: 800 tokens")).toBeVisible();
    expect(within(panel).getAllByText("Provider requests: 2")).not.toHaveLength(0);
    expect(within(panel).getAllByText("openai / gpt-5.6-sol")).not.toHaveLength(0);

    const user = userEvent.setup();
    await user.click(within(panel).getByText("Show provider requests"));
    expect(within(panel).getByText("fallback / fallback-model")).toBeVisible();
    expect(within(panel).getByText("$0.005300")).toBeVisible();
  });

  it("renders exact local zero and unknown cost distinctly", async () => {
    const { unmount } = renderPanel(zeroSummary);
    expect(await screen.findByText("$0.0000")).toBeVisible();
    expect(screen.queryByText("Cost unavailable")).not.toBeInTheDocument();

    unmount();
    renderPanel(unknownSummary);
    expect(await screen.findByText("Cost unavailable")).toBeVisible();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("keeps the last known total visible while a live cost query is calculating", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(taskCostQueries.forTask("task-live").queryKey, {
      ...exactSummary,
      taskId: "task-live",
      total: { currency: "USD", micros: 10_000 },
    });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    render(
      <QueryClientProvider client={client}>
        <CostPanel taskId="task-live" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("$0.0100")).toBeVisible();
    expect(screen.getByText("Calculating…")).toBeVisible();
  });
});
