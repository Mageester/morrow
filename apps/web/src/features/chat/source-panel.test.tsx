import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchSourcesResponse } from "@morrow/contracts";
import { researchSourceQueries } from "../../api/research-sources.js";
import { SourcePanel } from "./source-panel.js";

const response: ResearchSourcesResponse = {
  version: 1,
  taskId: "task-1",
  sources: [{
    version: 1,
    id: "source-1",
    taskId: "task-1",
    url: "https://example.com/news",
    title: "Example news",
    publisher: "Example Publisher",
    retrievedAt: "2026-08-11T12:00:00.000Z",
    publishedAt: "2026-08-10T12:00:00.000Z",
    contentHash: "a".repeat(64),
    sourceType: "web",
    trustStatus: "untrusted",
    validationStatus: "validated",
    citations: [{ claim: "The release shipped today.", excerpt: "The release shipped today." }],
  }],
};

function renderPanel() {
  const query = researchSourceQueries.forTask("task-1");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(query.queryKey, response);
  return render(<QueryClientProvider client={queryClient}><SourcePanel taskId="task-1" /></QueryClientProvider>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SourcePanel", () => {
  it("keeps citations collapsed by default and exposes safe provenance metadata", async () => {
    renderPanel();
    const panel = await screen.findByRole("region", { name: "Research sources" });
    expect(within(panel).getByText("1 source")).toBeVisible();
    expect(within(panel).queryByText("Example news")).not.toBeInTheDocument();

    await userEvent.setup().click(within(panel).getByRole("button", { name: "Show sources" }));
    expect(within(panel).getByText("Example news")).toBeVisible();
    expect(within(panel).getByText("Example Publisher")).toBeVisible();
    expect(within(panel).getByText(/Retrieved Aug 11, 2026/)).toBeVisible();
    expect(within(panel).getByText("Untrusted fetched content; recency does not establish authority.")).toBeVisible();
    expect(within(panel).getByText(/Cited excerpt: The release shipped today\./)).toBeVisible();
    expect(within(panel).getByText(/Claim: The release shipped today/)).toBeVisible();
  });

  it("shows a truthful empty state without offering an automatic memory write", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(researchSourceQueries.forTask("task-empty").queryKey, { version: 1, taskId: "task-empty", sources: [] });
    render(<QueryClientProvider client={queryClient}><SourcePanel taskId="task-empty" /></QueryClientProvider>);
    expect(await screen.findByText("No research sources recorded.")).toBeVisible();
    expect(screen.queryByText(/Save.*memory/i)).not.toBeInTheDocument();
  });
});
