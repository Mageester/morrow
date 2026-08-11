import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveProjectProvider } from "../../state/active-project.js";
import { TeamsPage } from "./teams-page.js";

const now = "2026-08-11T12:00:00.000Z";
const project = { id: "project-1", name: "Local project", version: 1, workspacePath: "C:\\local", createdAt: now };
const team = {
  version: 1, id: "team-1", projectId: project.id, name: "Research and verify", purpose: "Research then verify.",
  status: "active", sharedMemoryPolicy: "read", defaultMaxProviderCalls: 8, defaultMaxTokenBudget: 20000,
  defaultMaxWallClockMs: 300000, defaultConcurrencyLimit: 1, defaultApprovalRequired: true, artifactPolicy: "verified_only",
  revision: 1, createdAt: now, updatedAt: now,
};
const researcher = {
  version: 1, id: "agent-researcher", projectId: project.id, name: "Researcher", role: "researcher", instructions: null,
  providerOverride: null, modelOverride: null, enabled: true, teamId: team.id, memoryReadScopes: ["project", "agent"],
  memoryWriteScopes: ["agent"], maxProviderCalls: 4, maxTokenBudget: 8000, maxWallClockMs: 120000, maxChildTasks: null,
  approvalRequired: false, createdBy: "user", createdAt: now, updatedAt: now,
};

function renderPage() {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/", component: TeamsPage });
  const router = createRouter({ history: createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([route]) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActiveProjectProvider>
        <RouterProvider router={router as AnyRouter} />
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

describe("Teams page", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers to create the Research & verify preset when there are no teams yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url.endsWith("/teams")) return Response.json([]);
      return Response.json({});
    }));
    renderPage();
    expect(await screen.findByRole("heading", { name: "No teams yet" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Create Research & verify team/ })).toBeVisible();
  });

  it("lists an existing team and expands its effective policy on demand", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url.endsWith("/teams")) return Response.json([team]);
      if (url.includes(`/teams/${team.id}`)) return Response.json({ team, members: [researcher] });
      return Response.json({});
    }));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("Research and verify")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Research and verify/ }));
    expect(await screen.findByText("Effective policy — inspect before it runs")).toBeVisible();
    expect(screen.getByText(/project, agent/)).toBeVisible();
  });
});
