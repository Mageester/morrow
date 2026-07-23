import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveProjectProvider } from "../../state/active-project.js";
import { ChatsPage } from "./chats-page.js";

const now = "2026-07-22T12:00:00.000Z";
const project = { id: "project-1", name: "Local project", version: 1, workspacePath: "C:\\local", createdAt: now };
const active = { id: "chat-active", projectId: project.id, title: "Current research", archived: false, version: 1, createdAt: now, updatedAt: now };
const archived = { ...active, id: "chat-archived", title: "Archived notes", archived: true };

function renderPage() {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/", component: ChatsPage });
  const router = createRouter({ history: createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([route]) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActiveProjectProvider>
        <RouterProvider router={router as AnyRouter} />
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

describe("Chats page", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows project-owned active and archived truth with usable rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url.includes("includeArchived=true")) return Response.json([active, archived]);
      return Response.json([active]);
    }));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole("link", { name: /Current research/ })).toHaveAttribute("href", "/chats/chat-active?projectId=project-1");
    await user.click(screen.getByRole("button", { name: "Archived" }));
    expect(await screen.findByRole("link", { name: /Archived notes/ })).toBeVisible();
  });

  it("offers an honest retry after an initial failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([project]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "OFFLINE", message: "offline" } }), { status: 503 }))
      .mockResolvedValueOnce(Response.json([active]));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /Current research/ })).toBeVisible();
  });
});
