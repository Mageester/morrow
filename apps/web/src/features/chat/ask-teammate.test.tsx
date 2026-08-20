import type { RosterEntry } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskTeammate } from "./ask-teammate.js";

const baseRosterEntry: RosterEntry = {
  version: 1,
  agentId: "agent-current",
  name: "Current",
  role: "assistant",
  instructions: null,
  modelLabel: null,
  enabled: true,
  status: "idle",
  lastLine: null,
  lastActivityAt: null,
  conversationId: "conversation-current",
  conversationCount: 1,
  runningTaskCount: 0,
  pendingApprovalCount: 0,
};

function entry(overrides: Partial<RosterEntry>): RosterEntry {
  return { ...baseRosterEntry, ...overrides };
}

const candidate = entry({
  agentId: "agent-research",
  name: "Research",
  role: "researcher",
  conversationId: null,
  conversationCount: 0,
});

const roster = {
  version: 1 as const,
  projectId: "project-1",
  entries: [
    baseRosterEntry,
    candidate,
    entry({ agentId: "agent-disabled", name: "Retired", role: "writer", enabled: false }),
    entry({ agentId: null, name: "Morrow", role: "assistant", conversationId: "conversation-default" }),
  ],
};

const startedHandoff = {
  version: 1 as const,
  handoffTaskId: "task-child",
  agentId: candidate.agentId!,
  agentName: candidate.name,
};

function apiError(message: string, code = "HANDOFF_FAILED") {
  return new Response(JSON.stringify({ version: 1, error: { code, message } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

function renderAsk() {
  return render(
    <QueryClientProvider
      client={new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })}
    >
      <AskTeammate
        conversationId="conversation-current"
        currentAgentId="agent-current"
        parentTaskId="task-parent"
        projectId="project-1"
      />
    </QueryClientProvider>,
  );
}

function stubRosterFetch(
  onPost: (url: string, init?: RequestInit) => Response | Promise<Response> = () => Response.json(startedHandoff, { status: 201 }),
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/roster")) return Response.json(roster);
    if (url.endsWith("/handoffs") && init?.method === "POST") return onPost(url, init);
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("AskTeammate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses to render an ask action before the thread has a parent task", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AskTeammate
          conversationId="conversation-current"
          currentAgentId="agent-current"
          parentTaskId={null}
          projectId="project-1"
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("button", { name: "Ask a teammate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Ask a teammate" })).not.toBeInTheDocument();
  });

  it("opens an accessible target menu and excludes the current, disabled, and default voices", async () => {
    stubRosterFetch();
    const user = userEvent.setup();
    renderAsk();

    const trigger = screen.getByRole("button", { name: "Ask a teammate" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Ask a teammate" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByRole("button", { name: /Research/ })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /Current/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Retired/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Morrow/ })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /Research/ }));
    const objective = await within(dialog).findByPlaceholderText(/Check whether the release notes/);
    expect(objective).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Ask Research" })).toBeDisabled();
  });

  it("sends only the selected objective and exposes a loading state until the handoff starts", async () => {
    let resolvePost!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolve) => { resolvePost = resolve; });
    const calls = stubRosterFetch(() => postResponse);
    const user = userEvent.setup();
    renderAsk();

    await user.click(screen.getByRole("button", { name: "Ask a teammate" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask a teammate" });
    await user.click(within(dialog).getByRole("button", { name: /Research/ }));
    const objective = within(dialog).getByPlaceholderText(/Check whether the release notes/);
    await user.type(objective, "Check the release notes for the export format.");
    await user.click(within(dialog).getByRole("button", { name: "Ask Research" }));

    expect(await within(dialog).findByRole("button", { name: "Asking…" })).toBeDisabled();
    const post = calls.find(({ url, init }) => url.endsWith("/handoffs") && init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      parentTaskId: "task-parent",
      agentId: "agent-research",
      objective: "Check the release notes for the export format.",
    });

    resolvePost(Response.json(startedHandoff, { status: 201 }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Ask a teammate" })).not.toBeInTheDocument());
  });

  it("keeps the target dialog open and announces a structured request error", async () => {
    stubRosterFetch(() => apiError("Research is not available right now."));
    const user = userEvent.setup();
    renderAsk();

    await user.click(screen.getByRole("button", { name: "Ask a teammate" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask a teammate" });
    await user.click(within(dialog).getByRole("button", { name: /Research/ }));
    const objective = within(dialog).getByPlaceholderText(/Check whether the release notes/);
    await user.type(objective, "Check the release notes.");
    await user.click(within(dialog).getByRole("button", { name: "Ask Research" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Research is not available right now.");
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Ask Research" })).toBeEnabled();
  });

  it("explains the refusal when no other enabled teammate can be selected", async () => {
    const noCandidateRoster = {
      ...roster,
      entries: [baseRosterEntry, entry({ agentId: "agent-disabled", name: "Retired", enabled: false })],
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(noCandidateRoster)));
    const user = userEvent.setup();
    renderAsk();

    await user.click(screen.getByRole("button", { name: "Ask a teammate" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask a teammate" });
    expect(within(dialog).getByText(/There is no one else to ask yet/)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /Ask / })).not.toBeInTheDocument();
  });
});
