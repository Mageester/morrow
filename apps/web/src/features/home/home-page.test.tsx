import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveProjectProvider } from "../../state/active-project.js";
import { HomePage } from "./home-page.js";

const now = "2026-07-22T12:00:00.000Z";
const project = { id: "project-1", name: "Local project", version: 1, workspacePath: "C:\\local", createdAt: now };
const conversation = { id: "conv-1", projectId: "project-1", title: "Local research", archived: false, version: 1, createdAt: now, updatedAt: now };

function renderHome(fetchImpl: (input: RequestInfo | URL) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/", component: HomePage });
  const chats = createRoute({ getParentRoute: () => root, path: "/chats", component: () => null });
  const conversationRoute = createRoute({
    getParentRoute: () => root,
    path: "/chats/$conversationId",
    validateSearch: (search: Record<string, unknown>) => ({ projectId: search.projectId as string }),
    component: () => null,
  });
  const missions = createRoute({ getParentRoute: () => root, path: "/missions", component: () => null });
  const projects = createRoute({ getParentRoute: () => root, path: "/projects", component: () => null });
  const connections = createRoute({ getParentRoute: () => root, path: "/connections", component: () => null });
  const mission = createRoute({ getParentRoute: () => root, path: "/missions/$missionId", component: () => null });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([home, chats, conversationRoute, missions, mission, projects, connections]),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActiveProjectProvider>
        <RouterProvider router={router as AnyRouter} />
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

const emptyMissions = () => Response.json([]);

describe("HomePage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("greets the user, offers a new chat, and links recent conversations", async () => {
    renderHome(async (input) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url.includes("/web/missions")) return emptyMissions();
      if (url.includes("/conversations")) return Response.json([conversation]);
      throw new Error(`unexpected ${url}`);
    });

    expect(await screen.findByRole("heading", { level: 1 })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled(),
    );
    expect(await screen.findByRole("link", { name: /Local research/ })).toHaveAttribute(
      "href",
      "/chats/conv-1?projectId=project-1",
    );
  });

  it("shows an honest empty state when there are no conversations yet", async () => {
    renderHome(async (input) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url.includes("/web/missions")) return emptyMissions();
      if (url.includes("/conversations")) return Response.json([]);
      throw new Error(`unexpected ${url}`);
    });

    expect(await screen.findByText(/No conversations yet/i)).toBeVisible();
  });

  it("offers a retry when recent chats fail to load", async () => {
    let conversationCalls = 0;
    renderHome(async (input) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url.includes("/web/missions")) return emptyMissions();
      if (url.includes("/conversations")) {
        conversationCalls += 1;
        if (conversationCalls === 1) {
          return new Response(JSON.stringify({ error: { code: "OFFLINE", message: "offline" } }), { status: 503 });
        }
        return Response.json([conversation]);
      }
      throw new Error(`unexpected ${url}`);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /Local research/ })).toBeVisible();
  });

  it("explains the no-project state without inventing data", async () => {
    renderHome(async (input) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([]);
      throw new Error(`unexpected ${url}`);
    });

    expect(await screen.findByText(/Your work begins with a place/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "New chat" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose a local project" })).toHaveAttribute("href", "/projects");
  });
});

describe("first run", () => {
  const emptyWorkspace = (providers: unknown[]) => async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/providers")) return Response.json(providers);
    return Response.json([]);
  };

  /**
   * With no project the empty state replaces the composer — and the composer is
   * where the "connect a model" prompt lives. A brand-new user was therefore
   * told a project was missing, never told a provider was missing, and given no
   * way to do either. Both first-run steps must be actionable from here; they
   * are now carried by the setup checklist, which also covers the case this
   * empty state never reached (a project exists but no provider is connected).
   */
  it("offers a way out when there is neither a project nor a provider", async () => {
    renderHome(emptyWorkspace([]));

    expect(await screen.findByRole("heading", { name: "Your work begins with a place" })).toBeVisible();
    expect(await screen.findByRole("link", { name: "Choose a local project" })).toBeVisible();
    expect(await screen.findByRole("link", { name: "Connect a model" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: /steps and you're running/i })).toBeVisible();
  });

  it("stops asking for a provider once one is connected", async () => {
    renderHome(emptyWorkspace([{ id: "groq", configured: true }]));

    expect(await screen.findByRole("link", { name: "Choose a local project" })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("link", { name: "Connect a model" })).not.toBeInTheDocument());
  });
});
