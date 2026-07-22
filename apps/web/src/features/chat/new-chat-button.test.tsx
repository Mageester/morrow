import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewChatButton } from "./new-chat-button.js";

const now = "2026-07-22T12:00:00.000Z";
const created = { id: "chat-new", projectId: "project-1", title: "New conversation", archived: false, version: 1, createdAt: now, updatedAt: now };

function renderButton(projectId?: string) {
  const root = createRootRoute({ component: () => <><NewChatButton projectId={projectId} /><Outlet /></> });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const chat = createRoute({ getParentRoute: () => root, path: "/chats/$conversationId", validateSearch: (search: Record<string, unknown>) => ({ projectId: search.projectId as string }), component: () => <textarea aria-label="Message Morrow" autoFocus /> });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({ history, routeTree: root.addChildren([home, chat]) });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router as AnyRouter} /></QueryClientProvider>);
  return { history };
}

describe("New chat action", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates exactly once while accepting, navigates canonically, and focuses the composer", async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { history } = renderButton("project-1");
    const button = await screen.findByRole("button", { name: "New chat" });
    await user.click(button);
    await user.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(Response.json(created, { status: 201 }));
    expect(await screen.findByRole("textbox", { name: "Message Morrow" })).toHaveFocus();
    expect(history.location.href).toBe("/chats/chat-new?projectId=project-1");
  });

  it("explains no-project state and allows a failed request to retry without an automatic duplicate", async () => {
    const { unmount } = render(<QueryClientProvider client={new QueryClient()}><NewChatButton /></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
    expect(screen.getByText(/local project/i)).toBeVisible();
    unmount();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "OFFLINE", message: "offline" } }), { status: 503 }))
      .mockResolvedValueOnce(Response.json(created, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    renderButton("project-1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New chat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not create/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("textbox", { name: "Message Morrow" })).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
