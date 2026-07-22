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
  const mission = createRoute({ getParentRoute: () => root, path: "/missions/$missionId", component: () => null });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([home, chats, conversationRoute, missions, mission]),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router as AnyRouter} />
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

    expect(await screen.findByText(/No local project yet/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });
});
