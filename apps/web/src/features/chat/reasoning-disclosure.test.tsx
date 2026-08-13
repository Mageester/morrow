import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as baseRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReasoningDisclosure } from "./reasoning-disclosure.js";

const entries = [
  { turnKey: "turn-1", providerId: "deepseek", content: "Inspect the workspace.", createdAt: "2026-08-11T00:00:00.000Z" },
  { turnKey: "turn-2", providerId: "deepseek", content: "Choose the smallest safe change.", createdAt: "2026-08-11T00:00:01.000Z" },
];

vi.mock("../../api/conversations.js", () => ({
  conversationQueries: {
    reasoning: () => ({
      queryKey: ["reasoning", "project-1", "conversation-1", "task-1"],
      queryFn: async () => ({ version: 1, taskId: "task-1", providerSupplied: true, entries }),
    }),
  },
}));

function render(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return baseRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

afterEach(() => vi.clearAllMocks());

describe("ReasoningDisclosure", () => {
  it("opens only the newest step and lets the user toggle older steps", async () => {
    const user = userEvent.setup();
    render(<ReasoningDisclosure active conversationId="conversation-1" projectId="project-1" taskId="task-1" />);

    expect(await screen.findByText("2 steps")).toBeVisible();
    const first = screen.getByRole("button", { name: /Step 1/ });
    const latest = screen.getByRole("button", { name: /Step 2/ });
    expect(latest.closest("article")).toHaveAttribute("data-latest", "true");
    expect(latest.closest("article")).toHaveAttribute("data-open", "true");
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(latest).toHaveAttribute("aria-expanded", "true");

    await user.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(first.closest("article")).toHaveAttribute("data-open", "true");
    expect(screen.getByText("Inspect the workspace.")).toBeVisible();
  });

  it("keeps provider provenance visible while streaming", async () => {
    render(<ReasoningDisclosure active conversationId="conversation-1" projectId="project-1" taskId="task-1" />);

    expect(await screen.findByRole("region", { name: "Model reasoning" })).toHaveTextContent("Provider-supplied");
    expect(screen.getByText("Model reasoning")).toBeVisible();
    expect(screen.getByText("Streaming")).toBeVisible();
  });
});
