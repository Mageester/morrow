import type { RosterEntry } from "@morrow/contracts";
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
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveProjectProvider } from "../../state/active-project.js";
import { RosterRail } from "./roster-rail.js";

const PROJECT = { version: 1, id: "project-1", name: "P1", workspacePath: "/tmp/p1", createdAt: "2026-08-20T09:00:00.000Z" };

function entry(overrides: Partial<RosterEntry>): RosterEntry {
  return {
    version: 1,
    agentId: "agent-1",
    name: "Research",
    role: "researcher",
    instructions: null,
    modelLabel: null,
    enabled: true,
    status: "idle",
    lastLine: null,
    lastActivityAt: null,
    conversationId: null,
    conversationCount: 0,
    runningTaskCount: 0,
    pendingApprovalCount: 0,
    ...overrides,
  } as RosterEntry;
}

function stubFetch(entries: RosterEntry[], extra?: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const override = extra?.(url, init);
    if (override) return override;
    if (url === "/api/projects") return Response.json([PROJECT]);
    if (url.endsWith("/roster")) return Response.json({ version: 1, projectId: "project-1", entries });
    return Response.json([]);
  }));
  return calls;
}

function renderRail(initialPath = "/") {
  const root = createRootRoute({ component: () => <><RosterRail onNavigate={() => {}} /><Outlet /></> });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/chats/$conversationId",
    validateSearch: (search: Record<string, unknown>) => ({ projectId: search.projectId as string }),
    component: () => <p>thread</p>,
  });
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = createRouter({ history, routeTree: root.addChildren([home, chat]) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActiveProjectProvider>
        <RouterProvider router={router as AnyRouter} />
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
  return { history };
}

describe("Teammate roster rail", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("lists every teammate with what they last did and how long ago", async () => {
    stubFetch([
      entry({
        agentId: null, name: "Morrow", role: "assistant", conversationId: "chat-default",
        lastLine: "Summarised the release notes.",
        lastActivityAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      }),
      entry({ agentId: "agent-1", name: "Research", lastLine: "Read six files.", lastActivityAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }),
    ]);
    renderRail();

    const rows = await screen.findAllByTestId("roster-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Morrow")).toBeVisible();
    expect(within(rows[0]!).getByText("Summarised the release notes.")).toBeVisible();
    expect(within(rows[0]!).getByText("3m")).toBeVisible();
    expect(within(rows[1]!).getByText("Research")).toBeVisible();
    expect(within(rows[1]!).getByText("2h")).toBeVisible();
  });

  it("distinguishes working from waiting on you, in text as well as colour", async () => {
    stubFetch([
      entry({ agentId: "agent-1", name: "Research", status: "working", runningTaskCount: 1 }),
      entry({ agentId: "agent-2", name: "Comms", status: "waiting", pendingApprovalCount: 1 }),
      entry({ agentId: "agent-3", name: "Retired", status: "disabled", enabled: false }),
    ]);
    renderRail();

    const rows = await screen.findAllByTestId("roster-row");
    expect(rows[0]).toHaveAttribute("data-status", "working");
    expect(within(rows[0]!).getByText("Working")).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute("data-status", "waiting");
    expect(within(rows[1]!).getByText("Waiting on you")).toBeInTheDocument();
    expect(rows[2]).toHaveAttribute("data-status", "disabled");
    expect(within(rows[2]!).getByText("Off")).toBeInTheDocument();
  });

  it("opens the teammate's existing thread rather than starting another one", async () => {
    const calls = stubFetch([entry({ agentId: "agent-1", name: "Research", conversationId: "chat-7" })]);
    const { history } = renderRail();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("roster-row"));

    expect(history.location.href).toBe("/chats/chat-7?projectId=project-1");
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
  });

  it("creates a thread bound to the teammate when they have none, exactly once", async () => {
    const created = {
      version: 1, id: "chat-new", projectId: "project-1", title: "New Conversation",
      archived: false, agentId: "agent-1",
      createdAt: "2026-08-20T09:00:00.000Z", updatedAt: "2026-08-20T09:00:00.000Z",
    };
    let resolveCreate!: (response: Response) => void;
    const calls = stubFetch(
      [entry({ agentId: "agent-1", name: "Research", conversationId: null })],
      (url, init) => (url.endsWith("/conversations") && init?.method === "POST"
        ? (new Promise<Response>((done) => { resolveCreate = done; }) as unknown as Response)
        : undefined),
    );
    const { history } = renderRail();
    const user = userEvent.setup();

    const row = await screen.findByTestId("roster-row");
    await user.click(row);
    await user.click(row);

    const posts = calls.filter((call) => call.init?.method === "POST");
    expect(posts).toHaveLength(1);
    // The binding is what makes it *their* thread; without it the first
    // message would run as the default assistant.
    expect(JSON.parse(String(posts[0]!.init!.body))).toEqual({ agentId: "agent-1" });

    resolveCreate(Response.json(created, { status: 201 }));
    await vi.waitFor(() => expect(history.location.href).toBe("/chats/chat-new?projectId=project-1"));
  });

  it("says so when the roster cannot be read, instead of rendering an empty rail", async () => {
    stubFetch([], (url) => (url.endsWith("/roster")
      ? new Response(JSON.stringify({ error: { code: "OFFLINE", message: "offline" } }), { status: 503 })
      : undefined));
    renderRail();

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryAllByTestId("roster-row")).toHaveLength(0);
  });

  it("hires a teammate from the rail and drops straight into a thread with them", async () => {
    const calls = stubFetch(
      [entry({ agentId: null, name: "Morrow", role: "assistant", conversationId: "chat-default" })],
      (url, init) => {
        if (url.endsWith("/agents") && init?.method === "POST") {
          return Response.json({
            version: 1, id: "agent-9", projectId: "project-1", name: "Comms", role: "writer",
            instructions: "Plain language, always.", providerOverride: null, modelOverride: null,
            enabled: true, teamId: null, memoryReadScopes: [], memoryWriteScopes: [],
            maxProviderCalls: null, maxTokenBudget: null, maxWallClockMs: null, maxChildTasks: null,
            approvalRequired: false, createdBy: "user",
            createdAt: "2026-08-20T09:00:00.000Z", updatedAt: "2026-08-20T09:00:00.000Z",
          }, { status: 201 });
        }
        if (url.endsWith("/conversations") && init?.method === "POST") {
          return Response.json({
            version: 1, id: "chat-comms", projectId: "project-1", title: "New Conversation",
            archived: false, agentId: "agent-9",
            createdAt: "2026-08-20T09:00:00.000Z", updatedAt: "2026-08-20T09:00:00.000Z",
          }, { status: 201 });
        }
        return undefined;
      },
    );
    const { history } = renderRail();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "New teammate" }));
    const dialog = await screen.findByRole("dialog", { name: "New teammate" });
    await user.type(within(dialog).getByRole("textbox", { name: /name/i }), "Comms");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /job/i }), "writer");
    await user.type(within(dialog).getByRole("textbox", { name: /what should they do/i }), "Plain language, always.");
    await user.click(within(dialog).getByRole("button", { name: "Create teammate" }));

    const agentPost = calls.find((call) => call.url.endsWith("/agents") && call.init?.method === "POST");
    expect(JSON.parse(String(agentPost!.init!.body))).toMatchObject({
      name: "Comms",
      role: "writer",
      instructions: "Plain language, always.",
      providerOverride: null,
      modelOverride: null,
    });
    await vi.waitFor(() => expect(history.location.href).toBe("/chats/chat-comms?projectId=project-1"));
  });

  it("closes the hiring panel on Escape without creating anything", async () => {
    const calls = stubFetch([entry({ agentId: null, name: "Morrow", role: "assistant" })]);
    renderRail();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "New teammate" }));
    expect(await screen.findByRole("dialog", { name: "New teammate" })).toBeVisible();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "New teammate" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
  });
});
