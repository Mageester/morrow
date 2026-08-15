import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadChatRouteHandoff } from "../chat/chat-composer.js";
import { loadChatDraft } from "../chat/draft-store.js";
import { HomeComposer } from "./home-composer.js";

const PROJECT_ID = "project-1";

/** Mounts the composer on a router, since starting a conversation navigates. */
function renderComposer(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  props: ComponentProps<typeof HomeComposer> = { projectId: PROJECT_ID },
) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const root = createRootRoute();
  const home = createRoute({
    component: () => <HomeComposer {...props} />,
    getParentRoute: () => root,
    path: "/",
  });
  const conversation = createRoute({
    component: () => null,
    getParentRoute: () => root,
    path: "/chats/$conversationId",
    validateSearch: (search: Record<string, unknown>) => ({ projectId: search.projectId as string }),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([home, conversation]),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })}>
      <RouterProvider router={router as unknown as AnyRouter} />
    </QueryClientProvider>,
  );
  return router;
}

const created = {
  archived: false,
  createdAt: "2026-08-13T12:00:00.000Z",
  id: "conv-9",
  projectId: PROJECT_ID,
  title: "New Conversation",
  updatedAt: "2026-08-13T12:00:00.000Z",
  version: 1,
};

describe("Home composer", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("stays disabled until an outcome is written, so the one copper action is never a dead click", async () => {
    renderComposer(async () => Response.json(created));

    const send = await screen.findByRole("button", { name: "Start a conversation with this message" });
    expect(send).toBeDisabled();

    await userEvent.setup().type(screen.getByRole("textbox"), "Draft the launch brief");
    await waitFor(() => expect(send).toBeEnabled());
  });

  /**
   * The field starts a conversation; it does not send. Sending commits to a
   * provider route, and that choice belongs in the conversation composer where
   * the resolved model, mode, and supervision are visible. The words must
   * survive the move, and nothing may leave the machine from here.
   */
  it("carries the typed words into the new conversation instead of sending them", async () => {
    const calls: string[] = [];
    renderComposer(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return Response.json(created);
    });

    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox"), "Turn the research into a launch brief");
    await user.click(screen.getByRole("button", { name: "Start a conversation with this message" }));

    await waitFor(() =>
      expect(loadChatDraft({ conversationId: "conv-9", projectId: PROJECT_ID })).toBe(
        "Turn the research into a launch brief",
      ),
    );
    expect(calls.some((call) => call.includes("/messages"))).toBe(false);
  });

  it("explains itself rather than failing when no project is open", async () => {
    renderComposer(async () => Response.json([]), { projectId: undefined });

    expect(
      await screen.findByText("Open a local project before starting a conversation."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Start a conversation with this message" })).toBeDisabled();
  });

  it("reports a failure to open a conversation instead of navigating nowhere", async () => {
    renderComposer(async () => Response.json({ error: "nope" }, { status: 500 }));

    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox"), "Something");
    await user.click(screen.getByRole("button", { name: "Start a conversation with this message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not open a conversation/i);
  });

  it("writes an opening into the field so it can be edited before it is used", async () => {
    renderComposer(async () => Response.json(created));

    await userEvent.setup().click(await screen.findByRole("button", { name: "Research a decision" }));

    expect(screen.getByRole("textbox")).toHaveValue(
      "Research this decision and separate what is verified from what is still an assumption: ",
    );
  });

  it("changes the model from a polished picker and carries that route into the conversation", async () => {
    const routes = [
      { id: "model:deepseek:deepseek-v4-flash", label: "deepseek-v4-flash", model: "deepseek-v4-flash", providerId: "deepseek" as const },
      { id: "model:openrouter:anthropic/claude-sonnet", label: "anthropic/claude-sonnet", model: "anthropic/claude-sonnet", providerId: "openrouter" as const },
    ];
    renderComposer(async () => Response.json(created), { initialRoute: routes[0], projectId: PROJECT_ID, routes });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /DeepSeek.*deepseek-v4-flash/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /anthropic\/claude-sonnet/i }));
    expect(screen.getByRole("button", { name: /OpenRouter.*anthropic\/claude-sonnet/i })).toBeVisible();
    await user.type(screen.getByRole("textbox"), "Use the selected model");
    await user.click(screen.getByRole("button", { name: "Start a conversation with this message" }));
    await waitFor(() => expect(loadChatRouteHandoff({ conversationId: "conv-9", projectId: PROJECT_ID })).toMatchObject({ providerId: "openrouter", model: "anthropic/claude-sonnet" }));
  });
});
