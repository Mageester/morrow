import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMeter } from "./context-meter.js";

function renderMeter(context: unknown, taskId: string | undefined = "task-1") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/tasks/task-1") return Response.json({ context });
      throw new Error(`unexpected ${String(input)}`);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ContextMeter taskId={taskId} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ContextMeter", () => {
  it("reports usage against the route's context window", async () => {
    renderMeter({ contextWindowTokens: 120_000, currentRequestTokens: 5_912, exact: true });
    expect(await screen.findByText("5% of context used — 6K of 120K tokens")).toBeInTheDocument();
  });

  it("marks a derived count as estimated rather than presenting it as measured", async () => {
    renderMeter({ contextWindowTokens: 120_000, currentRequestTokens: 5_912, exact: false });
    expect(await screen.findByText(/estimated$/)).toBeInTheDocument();
  });

  /**
   * The orchestrator returns null token counts when a provider reported no
   * usage, and many gateway models advertise a null context window. Rendering
   * either as 0% would be a fabricated reassurance — showing nothing is the
   * honest outcome.
   */
  it("renders nothing when the provider reported no usage", async () => {
    const { container } = renderMeter({ contextWindowTokens: 120_000, currentRequestTokens: null });
    await waitFor(() => expect(container.querySelector(".morrow-context-meter")).toBeNull());
  });

  it("renders nothing when the model advertises no context window", async () => {
    const { container } = renderMeter({ contextWindowTokens: null, currentRequestTokens: 5_912 });
    await waitFor(() => expect(container.querySelector(".morrow-context-meter")).toBeNull());
  });

  it("renders nothing before the conversation's first turn", () => {
    const { container } = renderMeter(null, undefined);
    expect(container.querySelector(".morrow-context-meter")).toBeNull();
  });
});
