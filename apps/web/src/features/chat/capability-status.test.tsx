import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityStatus, type CapabilityStatusProps } from "./capability-status.js";

function renderStatus(props: CapabilityStatusProps, taskResponse?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (props.taskId && String(input) === `/api/tasks/${props.taskId}`) {
        return Response.json(taskResponse ?? { context: null, routing: null, reasoningApplication: null });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CapabilityStatus {...props} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CapabilityStatus", () => {
  it("renders nothing before a route is chosen and before the first turn", () => {
    const { container } = renderStatus({});
    expect(container.querySelector(".morrow-capability-status")).toBeNull();
  });

  it("shows the configured route before any request has been sent", () => {
    renderStatus({
      route: { id: "model:gemini:gemini-3.7-flash", label: "Gemini 3.7 Flash", providerId: "gemini", model: "gemini-3.7-flash" },
    });
    expect(screen.getByText(/Gemini/)).toBeInTheDocument();
  });

  it("exposes exact provider, model, context numbers, and the applied wire config once a turn has run", async () => {
    const user = userEvent.setup();
    renderStatus(
      {
        taskId: "task-1",
        route: { id: "model:gemini:gemini-3.7-flash", label: "Gemini 3.7 Flash", providerId: "gemini", model: "gemini-3.7-flash" },
        reasoningConfig: { mode: "effort", effort: "high" },
      },
      {
        context: {
          providerId: "gemini",
          model: "gemini-3.7-flash",
          contextWindowTokens: 1_000_000,
          currentRequestTokens: 12_000,
          currentModelVisibleTokens: 12_000,
          maxInputTokens: 990_000,
          exact: true,
          contextWindowConfidence: "verified",
          nativeContextWindowTokens: 1_000_000,
          nativeContextWindowSource: "model-metadata",
          routeLimitTokens: null,
          routeLimitSource: "unknown",
          effectiveContextWindowTokens: 1_000_000,
          contextWindowSource: "model-metadata",
          harnessReserveTokens: 1_536,
          totalReserveTokens: 3_584,
          compactionThresholdTokens: 800_000,
          compactionThresholdRatio: 0.8,
        },
        routing: { providerId: "gemini", model: "gemini-3.7-flash", fallbackUsed: false },
        reasoningApplication: {
          requested: { mode: "effort", effort: "high" },
          applied: { mode: "effort", effort: "high" },
          supported: true,
          wireParams: { thinkingConfig: { thinkingLevel: "HIGH" } },
          control: "effort",
          source: "provider-catalog",
          fallbackToRouteDefault: false,
        },
      },
    );

    const trigger = await screen.findByRole("button", { name: /Gemini/ });
    await user.click(trigger);

    expect(screen.getByText("gemini-3.7-flash")).toBeInTheDocument();
    expect(screen.getByText(/12K tokens/)).toBeInTheDocument();
    expect(screen.getByText("thinkingConfig.thinkingLevel: HIGH")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("shows a fallback flag and the unsupported reason when a reasoning selection was rejected", async () => {
    const user = userEvent.setup();
    renderStatus(
      { taskId: "task-1", route: { id: "model:deepseek:deepseek-v4-flash", label: "DeepSeek V4 Flash", providerId: "deepseek", model: "deepseek-v4-flash" } },
      {
        context: null,
        routing: { providerId: "deepseek", model: "deepseek-v4-flash", fallbackUsed: false },
        reasoningApplication: {
          requested: { mode: "effort", effort: "high" },
          applied: { mode: "auto" },
          supported: false,
          unsupportedReason: "Unsupported reasoning effort \"high\" for this exact route.",
          wireParams: null,
          fallbackToRouteDefault: true,
        },
      },
    );

    await waitFor(() => expect(screen.getByText("Fallback")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    expect(screen.getByText(/No — Unsupported reasoning effort/)).toBeInTheDocument();
    // routing exists (a request really happened) but this task recorded no
    // context snapshot at all — that must never read as "no request yet".
    expect(screen.getByText("Runtime usage unavailable")).toBeInTheDocument();
    // No context record at all means the route cap was never checked either.
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  /**
   * Regression: a task whose runtime snapshot resolved (routing recorded)
   * but genuinely has no usage telemetry — e.g. the query first fetched
   * while the task was still streaming and nothing has told it to look
   * again — used to render identically to a conversation that had never
   * sent a message. Once Morrow provably knows a request was made, "No
   * request yet" is a false statement.
   */
  it("says usage is unavailable, not 'no request yet', once a request is known to have happened", async () => {
    const user = userEvent.setup();
    renderStatus(
      { taskId: "task-1", route: { id: "model:nvidia-nim:nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", providerId: "nvidia-nim", model: "nvidia/nemotron-3-ultra-550b-a55b" } },
      { context: null, routing: { providerId: "nvidia-nim", model: "nvidia/nemotron-3-ultra-550b-a55b", fallbackUsed: false }, reasoningApplication: null },
    );

    const trigger = await screen.findByRole("button", { name: /Nvidia/i });
    await user.click(trigger);
    expect(screen.getByText("Runtime usage unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No request yet")).not.toBeInTheDocument();
  });

  it("says 'No request yet' only when the task has never recorded routing, context, or reasoning", async () => {
    const user = userEvent.setup();
    renderStatus(
      { taskId: "task-1", route: { id: "model:nvidia-nim:nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", providerId: "nvidia-nim", model: "nvidia/nemotron-3-ultra-550b-a55b" } },
      { context: null, routing: null, reasoningApplication: null },
    );

    const trigger = await screen.findByRole("button", { name: /Nvidia/i });
    await user.click(trigger);
    expect(screen.getByText("No request yet")).toBeInTheDocument();
    expect(screen.queryByText("Runtime usage unavailable")).not.toBeInTheDocument();
  });

  it("shows 'Loading…' instead of a premature empty state while the snapshot is still in flight", async () => {
    // No taskResponse resolution races here: the fetch promise never settles
    // during the assertion, so the query is still pending throughout.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <CapabilityStatus
          route={{ id: "model:nvidia-nim:nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", providerId: "nvidia-nim", model: "nvidia/nemotron-3-ultra-550b-a55b" }}
          taskId="task-1"
        />
      </QueryClientProvider>,
    );
    // The trigger renders instantly from the configured route; only the
    // panel's runtime fields wait on the network.
    const trigger = screen.getByRole("button", { name: /Nvidia/i });
    await user.click(trigger);
    const loadingRows = screen.getAllByText("Loading…");
    expect(loadingRows.length).toBeGreaterThanOrEqual(2); // Used, and Provider / route cap
    expect(screen.queryByText("No request yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Not separately capped")).not.toBeInTheDocument();
  });

  it("distinguishes an unknown route cap from a verified absence of one", async () => {
    const user = userEvent.setup();
    renderStatus(
      { taskId: "task-1", route: { id: "model:deepseek:deepseek-v4-flash", label: "DeepSeek V4 Flash", providerId: "deepseek", model: "deepseek-v4-flash" } },
      {
        context: {
          contextWindowTokens: 1_000_000,
          currentModelVisibleTokens: 5_000,
          routeLimitTokens: null,
          // A real source — Morrow checked and confirmed there is none —
          // must read differently from a source of "unknown".
          routeLimitSource: "provider-metadata",
        },
        routing: { providerId: "deepseek", model: "deepseek-v4-flash", fallbackUsed: false },
        reasoningApplication: null,
      },
    );

    await user.click(await screen.findByRole("button", { name: /DeepSeek/ }));
    expect(screen.getByText("Not separately capped")).toBeInTheDocument();
    expect(screen.getByText(/Provider metadata/)).toBeInTheDocument();
  });
});
