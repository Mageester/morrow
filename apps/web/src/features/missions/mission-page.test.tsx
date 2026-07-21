import type { WebMissionSnapshot } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../../app/router.js";
import { RuntimeStatusProvider } from "../../state/runtime-status.js";
import { ThemeProvider } from "../../state/theme.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (typeof listener === "function") this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data = "") {
    const event = new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function snapshot(): WebMissionSnapshot {
  return {
    artifacts: [
      {
        createdAt: "2026-07-21T13:20:00.000Z",
        id: "artifact-1",
        kind: "document",
        mimeType: "text/markdown",
        missionId: "mission-42",
        openPath: null,
        preview: "A safe artifact preview.",
        title: "Launch brief",
        version: 1,
      },
    ],
    attention: [
      {
        canContinueElsewhere: true,
        choices: [],
        createdAt: "2026-07-21T13:30:00.000Z",
        explanation: "Choose whether the final draft should be published.",
        id: "attention-1",
        kind: "decision",
        missionId: "mission-42",
        recommendation: "Review the draft first.",
        title: "Publication decision",
      },
    ],
    currentWork: "Comparing the draft against the launch checklist.",
    milestones: [
      { evidenceIds: ["evidence-1"], id: "m1", state: "completed", title: "Gather requirements" },
      { evidenceIds: ["evidence-2"], id: "m2", state: "completed", title: "Draft launch brief" },
      { evidenceIds: [], id: "m3", state: "running", title: "Review the evidence" },
      { evidenceIds: [], id: "m4", state: "pending", title: "Prepare delivery" },
      { evidenceIds: [], id: "m5", state: "failed", title: "Confirm publication" },
    ],
    recentActivity: [
      {
        actor: { kind: "specialist", name: "Researcher" },
        artifactIds: ["artifact-1"],
        createdAt: "2026-07-21T13:45:00.000Z",
        cursor: 4,
        detail: "PRIVATE CHAIN OF THOUGHT: internal scoring and hidden prompt",
        id: "activity-4",
        kind: "progress",
        missionId: "mission-42",
        summary: "Reviewed the launch evidence.",
      },
    ],
    summary: {
      attentionCount: 1,
      completedMilestones: 2,
      createdAt: "2026-07-21T13:00:00.000Z",
      currentPhase: "Reviewing evidence",
      id: "mission-42",
      latestActivity: "Reviewed the launch evidence.",
      objective: "Prepare an evidence-backed launch brief.",
      projectId: "project-1",
      state: "working",
      title: "Prepare the launch",
      totalMilestones: 5,
      updatedAt: "2026-07-21T13:45:00.000Z",
      version: 1,
      workspaceId: "workspace-personal-project-1",
    },
    verification: {
      caveats: [],
      evidenceCount: 2,
      state: "in_progress",
      summary: "Evidence review is in progress.",
    },
    version: 1,
  };
}

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, ...(headers ? { headers } : {}) });
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

function installApi(
  missionHandler: () => Response | Promise<Response> = () => json(snapshot()),
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/health") {
      return Promise.resolve(json({ ok: true, service: "morrow-orchestrator" }));
    }
    if (path === "/api/web/missions/mission-42") {
      return Promise.resolve(missionHandler());
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderMission() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: ["/app/missions/mission-42"] }),
  );

  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RuntimeStatusProvider>
          <RouterProvider router={router as AnyRouter} />
        </RuntimeStatusProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );

  return { queryClient, router };
}

function streamEnvelope(cursor: number) {
  return JSON.stringify({
    cursor,
    emittedAt: "2026-07-21T14:00:00.000Z",
    eventType: "mission.updated",
    missionId: "mission-42",
    payload: { eventId: `event-${cursor}`, raw: "PRIVATE INTERNAL PAYLOAD" },
    version: 1,
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MissionPage", () => {
  it("answers the five overview questions with milestone counts and states but no fabricated percentage or estimate", async () => {
    installApi();
    renderMission();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Prepare the launch" }),
    ).toBeVisible();
    expect(screen.getByText("Prepare an evidence-backed launch brief.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Completed" })).toBeVisible();
    expect(screen.getByText("Gather requirements")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Current work" })).toBeVisible();
    expect(
      screen.getByText("Comparing the draft against the launch checklist."),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Attention needed" })).toBeVisible();
    expect(screen.getByText("Publication decision")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Remaining milestones" })).toBeVisible();
    expect(screen.getByText("Review the evidence")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.getByText("Pending")).toBeVisible();
    expect(screen.getByText("Failed")).toBeVisible();
    expect(
      screen.getByText("2 completed · 3 remaining · 0 skipped · 5 total"),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent(/\d+\s*%|estimated|time remaining/i);
  });

  it("accounts for skipped milestones separately and reconciles every milestone with the total", async () => {
    const withSkipped = snapshot();
    withSkipped.milestones.push({
      evidenceIds: [],
      id: "m6",
      state: "skipped",
      title: "Publish an obsolete draft",
    });
    withSkipped.summary.totalMilestones = 6;
    installApi(() => json(withSkipped));
    renderMission();

    expect(
      await screen.findByText("2 completed · 3 remaining · 1 skipped · 6 total"),
    ).toBeVisible();
    const skippedHeading = screen.getByRole("heading", { name: "Skipped" });
    const skippedSurface = skippedHeading.closest(".morrow-surface");
    const completedSurface = screen
      .getByRole("heading", { name: "Completed" })
      .closest(".morrow-surface");
    expect(skippedSurface).not.toBeNull();
    const skippedMilestone = within(skippedSurface as HTMLElement)
      .getByText("Publish an obsolete draft")
      .closest("li");
    expect(skippedMilestone).not.toBeNull();
    expect(within(skippedMilestone as HTMLElement).getByText("Skipped")).toBeVisible();
    expect(
      within(completedSurface as HTMLElement).queryByText("Publish an obsolete draft"),
    ).not.toBeInTheDocument();
  });

  it("provides four keyboard-operable tabs with adaptive Work and Result views", async () => {
    installApi();
    const user = userEvent.setup();
    renderMission();

    const overview = await screen.findByRole("tab", { name: "Overview" });
    const activity = screen.getByRole("tab", { name: "Activity" });
    const work = screen.getByRole("tab", { name: "Work" });
    const result = screen.getByRole("tab", { name: "Result" });
    expect(screen.getByRole("tablist", { name: "Mission views" })).toBeVisible();
    expect(overview).toHaveAttribute("aria-selected", "true");
    expect(overview).toHaveAttribute("tabindex", "0");
    expect(activity).toHaveAttribute("tabindex", "-1");

    overview.focus();
    await user.keyboard("{ArrowRight}");
    expect(activity).toHaveFocus();
    expect(activity).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Activity" })).toBeVisible();

    await user.keyboard("{End}");
    expect(result).toHaveFocus();
    expect(
      screen.getByRole("heading", { level: 2, name: "Verification in progress" }),
    ).toBeVisible();

    await user.keyboard("{Home}");
    expect(overview).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(result).toHaveFocus();

    await user.click(work);
    expect(screen.getByRole("heading", { level: 2, name: "Work" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Launch brief" })).toBeVisible();
  });

  it("keeps all four controlled tabpanels stable while hiding only inactive panels", async () => {
    installApi();
    const user = userEvent.setup();
    renderMission();

    const tabElements = await screen.findAllByRole("tab");
    expect(tabElements).toHaveLength(4);
    for (const tab of tabElements) {
      const controlledId = tab.getAttribute("aria-controls");
      expect(controlledId).toBeTruthy();
      const panel = document.getElementById(controlledId as string);
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", tab.id);
      if (tab.getAttribute("aria-selected") === "true") {
        expect(panel).not.toHaveAttribute("hidden");
        expect(panel).toBeVisible();
      } else {
        expect(panel).toHaveAttribute("hidden");
        expect(panel).not.toBeVisible();
      }
    }

    const overviewPanel = document.getElementById(
      tabElements[0]?.getAttribute("aria-controls") ?? "",
    );
    const activityPanel = document.getElementById(
      tabElements[1]?.getAttribute("aria-controls") ?? "",
    );
    await user.click(tabElements[1] as HTMLElement);
    expect(overviewPanel).toHaveAttribute("hidden");
    expect(activityPanel).not.toHaveAttribute("hidden");
    expect(activityPanel).toBeVisible();
  });

  it("keeps activity collapsed and exposes only allowed technical metadata", async () => {
    installApi();
    const user = userEvent.setup();
    renderMission();

    await user.click(await screen.findByRole("tab", { name: "Activity" }));
    const summary = screen.getByText("Reviewed the launch evidence.");
    const details = summary.closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Researcher")).not.toBeVisible();
    expect(document.body).not.toHaveTextContent("PRIVATE CHAIN OF THOUGHT");
    expect(document.body).not.toHaveTextContent("PRIVATE INTERNAL PAYLOAD");

    await user.click(summary);
    expect(details).toHaveAttribute("open");
    expect(within(details as HTMLElement).getByText("Researcher")).toBeVisible();
    expect(within(details as HTMLElement).getByText("artifact-1")).toBeVisible();
    expect(within(details as HTMLElement).getByText("activity-4")).toBeVisible();
    expect(within(details as HTMLElement).getByText("4")).toBeVisible();
    expect(within(details as HTMLElement).getByText(/2026/)).toBeVisible();
    expect(document.body).not.toHaveTextContent("PRIVATE CHAIN OF THOUGHT");
  });

  it("renders explicit empty milestone and activity states", async () => {
    const empty = snapshot();
    empty.milestones = [];
    empty.recentActivity = [];
    empty.attention = [];
    empty.currentWork = null;
    empty.summary.completedMilestones = 0;
    empty.summary.totalMilestones = 0;
    empty.summary.attentionCount = 0;
    empty.summary.latestActivity = null;
    installApi(() => json(empty));
    const user = userEvent.setup();
    renderMission();

    expect(await screen.findByText("No milestones have been defined yet.")).toBeVisible();
    expect(screen.getByText("No attention is needed right now.")).toBeVisible();
    expect(screen.getByText("No current work is reported.")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("No meaningful activity has been recorded yet.")).toBeVisible();
  });

  it("shows loading, maps a typed unknown-mission error, and retries the authoritative query", async () => {
    const first = deferred<Response>();
    let missionRequests = 0;
    installApi(() => {
      missionRequests += 1;
      return missionRequests === 1
        ? first.promise
        : json(snapshot());
    });
    const user = userEvent.setup();
    renderMission();

    expect(await screen.findByText("Loading mission…")).toHaveAttribute(
      "role",
      "status",
    );
    first.resolve(
      json(
        {
          error: { code: "NOT_FOUND", message: "Mission not found" },
          version: 1,
        },
        404,
        { "x-trace-id": "trace-404" },
      ),
    );

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Mission not found");
    expect(error).toHaveTextContent("This mission is unavailable or no longer exists.");
    expect(error).toHaveTextContent("Your synchronized mission data remains unchanged.");
    await user.click(screen.getByRole("button", { name: "Retry mission" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Prepare the launch" }),
    ).toBeVisible();
    expect(missionRequests).toBe(2);
  });

  it("preserves a structured API failure message without inventing recovery details", async () => {
    installApi(() =>
      json(
        {
          error: {
            code: "RUNTIME_UNAVAILABLE",
            message: "The local runtime is unavailable.",
          },
          version: 1,
        },
        503,
      ),
    );
    renderMission();

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Mission could not be loaded");
    expect(error).toHaveTextContent("The local runtime is unavailable.");
    expect(error).not.toHaveTextContent("restarted");
  });

  it("retains synchronized mission data and the live stream when a background refetch fails", async () => {
    let missionRequests = 0;
    installApi(() => {
      missionRequests += 1;
      if (missionRequests === 2) {
        return json(
          {
            error: {
              code: "RUNTIME_UNAVAILABLE",
              message: "The local runtime is unavailable.",
            },
            version: 1,
          },
          503,
        );
      }
      return json(snapshot());
    });
    const user = userEvent.setup();
    renderMission();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Prepare the launch" }),
    ).toBeVisible();
    const source = FakeEventSource.instances[0];
    act(() => source?.emit("open"));
    act(() => source?.emit("mission.updated", streamEnvelope(1)));

    const warning = await screen.findByRole("status", {
      name: "Mission synchronization warning",
    });
    expect(warning).toHaveTextContent("Mission updates could not be synchronized.");
    expect(warning).toHaveTextContent("The local runtime is unavailable.");
    expect(screen.getByText("Prepare an evidence-backed launch brief.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source?.closed).toBe(false);
    expect(screen.getByText("Synchronized")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Retry synchronization" }));
    await waitFor(() => expect(missionRequests).toBe(3));
    await waitFor(() => {
      expect(
        screen.queryByRole("status", { name: "Mission synchronization warning" }),
      ).not.toBeInTheDocument();
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source?.closed).toBe(false);
  });

  it("announces only meaningful synchronized state and activity changes, not heartbeat/default messages", async () => {
    let missionRequests = 0;
    const updated = snapshot();
    updated.summary.state = "reviewing";
    updated.summary.currentPhase = "Independent review";
    updated.summary.latestActivity = "Requested independent verification.";
    updated.summary.updatedAt = "2026-07-21T14:00:00.000Z";
    updated.recentActivity = [
      ...updated.recentActivity,
      {
        actor: { kind: "morrow", name: "Morrow" },
        artifactIds: [],
        createdAt: "2026-07-21T14:00:00.000Z",
        cursor: 5,
        detail: "PRIVATE REASONING MUST STAY HIDDEN",
        id: "activity-5",
        kind: "verification",
        missionId: "mission-42",
        summary: "Requested independent verification.",
      },
    ];
    installApi(() => {
      missionRequests += 1;
      return json(missionRequests === 1 ? snapshot() : updated);
    });
    renderMission();

    await screen.findByRole("heading", { name: "Prepare the launch" });
    const source = FakeEventSource.instances[0];
    const announcements = screen.getByLabelText("Mission updates");
    expect(announcements).toBeEmptyDOMElement();

    act(() => source?.emit("open"));
    expect(screen.getByText("Synchronized")).toBeVisible();
    act(() => source?.emit("message", streamEnvelope(1)));
    expect(missionRequests).toBe(1);
    expect(announcements).toBeEmptyDOMElement();
    expect(screen.getByText("Synchronized")).toBeVisible();

    act(() => source?.emit("mission.updated", streamEnvelope(1)));
    await waitFor(() => expect(missionRequests).toBe(2));
    expect(
      await screen.findByText(
        "Mission state changed to Reviewing. Activity update: Requested independent verification.",
      ),
    ).toHaveAttribute("aria-live", "polite");
    expect(document.body).not.toHaveTextContent("PRIVATE REASONING");
    expect(document.body).not.toHaveTextContent("PRIVATE INTERNAL PAYLOAD");
  });
});
