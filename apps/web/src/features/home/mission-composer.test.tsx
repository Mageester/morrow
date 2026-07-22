import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionComposer } from "./mission-composer.js";

// MissionComposer is dormant after the chat-first Home landed (Slice 6); mission
// creation moves into the conversation in a later slice. These tests keep its
// core guarantees — empty-block, single create, honest no-provider note — under
// direct coverage so the component is never silently untested.

const now = "2026-07-22T12:00:00.000Z";

function snapshot(id = "mission-1") {
  return {
    version: 1,
    summary: {
      version: 1,
      id,
      projectId: "project-1",
      workspaceId: "workspace-personal-project-1",
      title: `Mission ${id}`,
      objective: "Prepare the release",
      state: "working",
      currentPhase: "Planning",
      modelLabel: "claude-sonnet-5",
      latestActivity: null,
      attentionCount: 0,
      completedMilestones: 0,
      totalMilestones: 0,
      createdAt: now,
      updatedAt: now,
    },
    milestones: [],
    currentWork: null,
    recentActivity: [],
    attention: [],
    artifacts: [],
    verification: { state: "not_ready", summary: "", evidenceCount: 0, caveats: [] },
  };
}

function renderComposer(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", fetchMock);
  const root = createRootRoute({
    component: () => (
      <>
        <MissionComposer activeProjectId="project-1" />
        <Outlet />
      </>
    ),
  });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const connections = createRoute({ getParentRoute: () => root, path: "/connections", component: () => null });
  const mission = createRoute({ getParentRoute: () => root, path: "/missions/$missionId", component: () => null });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([home, connections, mission]),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router as AnyRouter} />
    </QueryClientProvider>,
  );
  return fetchMock;
}

const missionPosts = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([input]) => String(input) === "/api/web/missions");

afterEach(() => vi.restoreAllMocks());

describe("MissionComposer", () => {
  it("does not submit an empty objective", async () => {
    const fetchMock = renderComposer(async (input) => {
      const url = String(input);
      if (url === "/api/providers") return Response.json([]);
      if (url === "/api/web/missions") return Response.json(snapshot(), { status: 201 });
      throw new Error(`unexpected ${url}`);
    });
    const objective = await screen.findByRole("textbox", { name: "Mission objective" });
    objective.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(missionPosts(fetchMock)).toHaveLength(0);
  });

  it("creates exactly one mission for a rapid double submit", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = renderComposer(async (input) => {
      const url = String(input);
      if (url === "/api/providers") return Response.json([]);
      if (url === "/api/web/missions") return pending;
      throw new Error(`unexpected ${url}`);
    });
    const user = userEvent.setup();
    const objective = await screen.findByRole("textbox", { name: "Mission objective" });
    await user.type(objective, "Prepare the release");
    await user.keyboard("{Enter}{Enter}");
    await waitFor(() => expect(missionPosts(fetchMock)).toHaveLength(1));
    release(Response.json(snapshot(), { status: 201 }));
  });

  it("warns and links to Connections when no model is configured", async () => {
    renderComposer(async (input) => {
      const url = String(input);
      if (url === "/api/providers") return Response.json([]);
      if (url === "/api/web/missions") return Response.json(snapshot(), { status: 201 });
      throw new Error(`unexpected ${url}`);
    });
    const note = await screen.findByText(/No AI model is connected yet/);
    expect(within(note).getByRole("link", { name: "Connect a model" })).toHaveAttribute(
      "href",
      "/connections",
    );
  });
});
