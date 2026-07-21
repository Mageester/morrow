import type { WebAttentionRequest, WebMissionSnapshot } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { missionKeys } from "../../api/query-keys.js";
import {
  AttentionCard,
  AttentionResolutionCoordinator,
} from "./attention-card.js";

function attention(
  overrides: Partial<WebAttentionRequest> = {},
): WebAttentionRequest {
  return {
    canContinueElsewhere: true,
    choices: [
      {
        description: "Morrow will continue with the approved command.",
        destructive: false,
        id: "approve",
        label: "Approve",
        recommended: true,
      },
      {
        description: "The command will not run and this mission may remain blocked.",
        destructive: true,
        id: "deny",
        label: "Deny",
        recommended: false,
      },
    ],
    createdAt: "2026-07-21T13:30:00.000Z",
    explanation: "The command can change files in the selected workspace.",
    id: "attention-1",
    kind: "approval",
    missionId: "mission-42",
    recommendation: "Approve only after reviewing the command consequences.",
    title: "Run the report command",
    ...overrides,
  };
}

function snapshot(
  request: WebAttentionRequest | null = null,
): WebMissionSnapshot {
  return {
    artifacts: [],
    attention: request ? [request] : [],
    currentWork: "Waiting for a decision.",
    milestones: [],
    recentActivity: [],
    summary: {
      attentionCount: request ? 1 : 0,
      completedMilestones: 0,
      createdAt: "2026-07-21T13:00:00.000Z",
      currentPhase: request ? "Waiting for approval" : "Continuing",
      id: "mission-42",
      latestActivity: null,
      objective: "Prepare an evidence-backed report.",
      projectId: "project-1",
      state: request ? "needs_input" : "working",
      title: "Prepare the report",
      totalMilestones: 0,
      updatedAt: request
        ? "2026-07-21T13:30:00.000Z"
        : "2026-07-21T13:31:00.000Z",
      version: 1,
      workspaceId: "workspace-personal-project-1",
    },
    verification: {
      caveats: [],
      evidenceCount: 0,
      state: "not_ready",
      summary: "Work is not ready for verification.",
    },
    version: 1,
  };
}

function structuredError(status: number, code: string, message: string) {
  return Response.json(
    { version: 1, error: { code, message } },
    { headers: { "x-trace-id": `trace-${status}` }, status },
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function renderCard(request = attention()) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  queryClient.setQueryData(missionKeys.detail("mission-42"), snapshot(request));
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AttentionResolutionCoordinator missionId="mission-42">
        <AttentionCard missionId="mission-42" request={request} />
      </AttentionResolutionCoordinator>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AttentionCard", () => {
  it("renders the complete attention contract without selecting or invoking the recommendation", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderCard();

    expect(screen.getByText("Waiting for your approval")).toBeVisible();
    expect(screen.getByText("What happened")).toBeVisible();
    expect(screen.getByText("Run the report command")).toBeVisible();
    expect(
      screen.getByText("The command can change files in the selected workspace."),
    ).toBeVisible();
    expect(
      screen.getByText("Approve only after reviewing the command consequences."),
    ).toBeVisible();
    expect(
      screen.getByText("Morrow will continue with the approved command."),
    ).toBeVisible();
    expect(screen.getByText(/unrelated work can continue/i)).toBeVisible();

    const recommended = screen.getByRole("button", { name: /approve/i });
    expect(recommended).toHaveAttribute("data-recommended", "true");
    expect(recommended).not.toHaveAttribute("aria-pressed", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["approval", "Waiting for your approval"],
    ["blocker", "External blocker"],
    ["connection", "Connection required"],
  ] as const)("maps %s attention to an honest named surface", (kind, label) => {
    renderCard(
      attention({
        choices: kind === "approval" ? attention().choices : [],
        kind,
        title:
          kind === "connection"
            ? "GitHub connection expired"
            : kind === "blocker"
              ? "Provider unavailable"
              : attention().title,
      }),
    );

    expect(screen.getByText(label)).toBeVisible();
    if (kind === "connection") {
      expect(screen.getByText("GitHub connection expired")).toBeVisible();
    }
    if (kind === "blocker") {
      expect(screen.getByText("Provider unavailable")).toBeVisible();
      expect(screen.getByText(/no safe choice was provided/i)).toBeVisible();
    }
  });

  it("posts an explicit non-destructive decision once with encoded ownership and caches the authoritative snapshot", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn<
      (_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>
    >(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const request = attention({
      id: "attention/#1",
      missionId: "mission/42 ?",
    });
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AttentionResolutionCoordinator missionId="mission/42 ?">
          <AttentionCard missionId="mission/42 ?" request={request} />
        </AttentionResolutionCoordinator>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    await user.type(
      screen.getByRole("textbox", { name: /decision note/i }),
      "Reviewed locally",
    );
    const approve = screen.getByRole("button", { name: /approve/i });
    fireEvent.click(approve);
    fireEvent.click(approve);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/web/missions/mission%2F42%20%3F/attention/attention%2F%231/resolve",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      choiceId: "approve",
      note: "Reviewed locally",
    });
    expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /deny/i })).toBeDisabled();

    const resolved = snapshot(null);
    resolved.summary.id = "mission/42 ?";
    await act(async () => {
      response.resolve(Response.json(resolved));
      await response.promise;
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData(missionKeys.detail("mission/42 ?")),
      ).toEqual(resolved);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: missionKeys.all });
    view.unmount();
  });

  it("serializes attention resolution across every card in one mission", async () => {
    const firstRequest = attention({
      id: "attention-1",
      title: "Approve the report command",
    });
    const secondRequest = attention({
      id: "attention-2",
      title: "Approve the release command",
    });
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const fetchMock = vi
      .fn<
        (_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>
      >()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const initial = snapshot(firstRequest);
    initial.attention = [firstRequest, secondRequest];
    initial.summary.attentionCount = 2;
    queryClient.setQueryData(missionKeys.detail("mission-42"), initial);
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    render(
      <QueryClientProvider client={queryClient}>
        <AttentionResolutionCoordinator missionId="mission-42">
          <AttentionCard missionId="mission-42" request={firstRequest} />
          <AttentionCard missionId="mission-42" request={secondRequest} />
        </AttentionResolutionCoordinator>
      </QueryClientProvider>,
    );

    const firstCard = screen
      .getByText("Approve the report command")
      .closest("article");
    const secondCard = screen
      .getByText("Approve the release command")
      .closest("article");
    expect(firstCard).not.toBeNull();
    expect(secondCard).not.toBeNull();

    fireEvent.click(
      within(firstCard as HTMLElement).getByRole("button", { name: /approve/i }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(
      within(secondCard as HTMLElement).getByRole("button", { name: /approve/i }),
    ).toBeDisabled();
    expect(
      within(secondCard as HTMLElement).getByRole("textbox", {
        name: /decision note/i,
      }),
    ).toBeDisabled();
    fireEvent.click(
      within(secondCard as HTMLElement).getByRole("button", { name: /approve/i }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    const afterFirst = snapshot(secondRequest);
    await act(async () => {
      firstResponse.resolve(Response.json(afterFirst));
      await firstResponse.promise;
    });
    await waitFor(() =>
      expect(
        within(secondCard as HTMLElement).getByRole("button", {
          name: /approve/i,
        }),
      ).toBeEnabled(),
    );

    fireEvent.click(
      within(secondCard as HTMLElement).getByRole("button", { name: /approve/i }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const afterSecond = snapshot(null);
    await act(async () => {
      secondResponse.resolve(Response.json(afterSecond));
      await secondResponse.promise;
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(missionKeys.detail("mission-42"))).toEqual(
        afterSecond,
      ),
    );
  });

  it("requires accessible destructive confirmation with cancel, Escape, focus restoration, and one confirmation", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn<
      (_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>
    >(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    renderCard();
    const user = userEvent.setup();
    const deny = screen.getByRole("button", { name: /deny/i });

    await user.click(deny);
    const dialog = screen.getByRole("alertdialog", {
      name: /confirm deny/i,
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deny).toHaveFocus();

    await user.click(deny);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deny).toHaveFocus();

    await user.click(deny);
    const confirm = screen.getByRole("button", { name: "Confirm deny" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      choiceId: "deny",
    });
  });

  it.each([
    [409, "ATTENTION_ALREADY_RESOLVED", "That request was already resolved."],
    [404, "NOT_FOUND", "That attention request was not found."],
    [503, "HTTP_ERROR", "Bearer secret-value must not be shown"],
  ])(
    "preserves the request and choices after a %s resolution failure",
    async (status, code, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => structuredError(status, code, message)),
      );
      renderCard();
      const user = userEvent.setup();
      await user.type(
        screen.getByRole("textbox", { name: /decision note/i }),
        "Keep this note",
      );

      await user.click(screen.getByRole("button", { name: /approve/i }));

      expect(await screen.findByRole("alert")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Refresh mission state" }),
      ).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: /diagnostics/i }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Run the report command")).toBeVisible();
      expect(screen.getByRole("button", { name: /approve/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: /deny/i })).toBeEnabled();
      expect(screen.getByRole("textbox", { name: /decision note/i })).toHaveValue(
        "Keep this note",
      );
      if (status >= 500) {
        expect(screen.queryByText(/secret-value/i)).not.toBeInTheDocument();
      }
    },
  );

  it("refreshes authoritative state after a lost destructive response and never reposts a resolved request", async () => {
    const request = attention();
    const resolved = snapshot(null);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return structuredError(
            503,
            "SERVICE_UNAVAILABLE",
            "The response was lost after the server handled it.",
          );
        }
        return Response.json(resolved);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient } = renderCard(request);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /deny/i }));
    await user.click(screen.getByRole("button", { name: "Confirm deny" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/decision outcome is not confirmed/i);

    await user.click(
      screen.getByRole("button", { name: "Refresh mission state" }),
    );

    expect(
      await screen.findByText(/attention request is no longer pending/i),
    ).toBeVisible();
    expect(
      queryClient.getQueryData(missionKeys.detail("mission-42")),
    ).toEqual(resolved);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("reopens destructive confirmation after refresh proves a lost-response request is still pending", async () => {
    const request = attention();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return structuredError(
            503,
            "SERVICE_UNAVAILABLE",
            "The response was lost before its outcome was known.",
          );
        }
        return Response.json(snapshot(request));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderCard(request);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /deny/i }));
    await user.click(screen.getByRole("button", { name: "Confirm deny" }));
    await screen.findByRole("alert");
    await user.click(
      screen.getByRole("button", { name: "Refresh mission state" }),
    );

    expect(
      await screen.findByRole("alertdialog", { name: /confirm deny/i }),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("renders a mismatched mission request inert and never posts cross-mission identifiers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderCard(attention({ missionId: "another-mission" }));

    expect(screen.getByText(/could not verify this request/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
