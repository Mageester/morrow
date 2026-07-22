import type { WebAttentionRequest, WebMissionSnapshot } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import {
  act,
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
        choices: [
          {
            description: "Continue with the reviewed draft.",
            destructive: false,
            id: "approve",
            label: "Approve draft",
            recommended: true,
          },
        ],
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
      modelLabel: "claude-sonnet-5",
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

/** A connection-recovery attention request, exactly as the projection emits it. */
function connectionRecovery(): WebAttentionRequest {
  return {
    canContinueElsewhere: false,
    choices: [
      {
        description: "Restart the mission from its saved state.",
        destructive: false,
        id: "retry",
        label: "Try again",
        recommended: true,
      },
    ],
    createdAt: "2026-07-21T13:32:00.000Z",
    explanation:
      "Morrow needs an AI model before it can work on this mission. Your mission is saved — nothing is lost. Open Connections, add a model provider, then retry. Technical reason: OpenAI is not configured (OPENAI_API_KEY missing)",
    id: "mission-42:dispatch-blocker",
    kind: "connection",
    missionId: "mission-42",
    recommendation:
      "Add a provider on the Connections page (an API key or a local Ollama server), then retry the mission.",
    title: "Connect an AI model to continue",
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

interface ApiHandlers {
  mission?: () => Response | Promise<Response>;
  stop?: () => Response | Promise<Response>;
  retry?: () => Response | Promise<Response>;
}

function installApi(handlers: ApiHandlers = {}) {
  const missionHandler = handlers.mission ?? (() => json(snapshot()));
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/health") {
      return Promise.resolve(json({ ok: true, service: "morrow-orchestrator" }));
    }
    if (path === "/api/web/missions/mission-42") {
      return Promise.resolve(missionHandler());
    }
    if (path === "/api/web/missions/mission-42/stop") {
      return Promise.resolve((handlers.stop ?? (() => json(stoppedSnapshot())))());
    }
    if (path === "/api/web/missions/mission-42/retry") {
      return Promise.resolve((handlers.retry ?? (() => json(retriedSnapshot())))());
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stoppedSnapshot(): WebMissionSnapshot {
  const stopped = snapshot();
  stopped.summary.state = "cancelled";
  stopped.summary.currentPhase = "Stopped";
  stopped.attention = [];
  return stopped;
}

function retriedSnapshot(): WebMissionSnapshot {
  const retried = snapshot();
  retried.summary.state = "working";
  retried.summary.currentPhase = "Doing the work";
  retried.attention = [];
  return retried;
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
  it("leads with one compact, authoritative header: state, phase, model — no fabricated percentage or estimate", async () => {
    installApi();
    renderMission();

    const header = (
      await screen.findByRole("heading", { level: 1, name: "Prepare the launch" })
    ).closest("header") as HTMLElement;
    expect(header).not.toBeNull();
    // Breadcrumb back to the mission list.
    expect(within(header).getByRole("link", { name: "Missions" })).toBeVisible();
    // Exactly one mission-state label, the phase, and the active model.
    expect(within(header).getByText("Working")).toBeVisible();
    expect(within(header).getByText("Reviewing evidence")).toBeVisible();
    expect(within(header).getByText("claude-sonnet-5")).toBeVisible();
    // A running mission can be stopped from the header.
    expect(within(header).getByRole("button", { name: "Stop" })).toBeVisible();
    // No contradictory second state and no invented progress metrics anywhere.
    expect(document.body).not.toHaveTextContent(/doing the work/i);
    expect(document.body).not.toHaveTextContent(/\d+\s*%|estimated|time remaining/i);
  });

  it("presents a context rail with objective, plan checklist, deliverables and model", async () => {
    installApi();
    renderMission();

    const rail = (await screen.findByRole("complementary", {
      name: "Mission context",
    })) as HTMLElement;
    expect(within(rail).getByRole("heading", { name: "Objective" })).toBeVisible();
    expect(
      within(rail).getByText("Prepare an evidence-backed launch brief."),
    ).toBeVisible();

    // The plan reconciles completed against total and lists every milestone.
    expect(within(rail).getByRole("heading", { name: /Plan/ })).toBeVisible();
    expect(within(rail).getByText("2/5")).toBeVisible();
    expect(within(rail).getByText("Gather requirements")).toBeVisible();
    expect(within(rail).getByText("Review the evidence")).toBeVisible();
    expect(within(rail).getByText("Confirm publication")).toBeVisible();

    // Deliverables and the active model are surfaced in the rail.
    expect(within(rail).getByRole("heading", { name: /Deliverables/ })).toBeVisible();
    expect(within(rail).getByText("Launch brief")).toBeVisible();
    expect(within(rail).getByText("claude-sonnet-5")).toBeVisible();
  });

  it("surfaces a waiting-on-you decision with its recommended choice", async () => {
    installApi();
    renderMission();

    const region = await screen.findByRole("region", { name: "Waiting on you" });
    expect(within(region).getByText("Publication decision")).toBeVisible();
    expect(
      within(region).getByRole("button", { name: /approve draft/i }),
    ).toHaveAttribute("data-recommended", "true");
  });

  it("leads a blocked mission with an actionable recovery card, never a buried failure", async () => {
    const blocked = snapshot();
    blocked.summary.state = "blocked";
    blocked.summary.currentPhase = "Paused — needs your attention";
    blocked.attention = [connectionRecovery()];
    installApi({ mission: () => json(blocked) });
    renderMission();

    const recovery = (await screen.findByRole("region", {
      name: "Connect an AI model to continue",
    })) as HTMLElement;
    // Setup framing, not an engineering audit string.
    expect(within(recovery).getByText("Setup needed")).toBeVisible();
    expect(
      within(recovery).getByText(/Morrow needs an AI model before it can work/),
    ).toBeVisible();
    // Direct, actionable routes: connect a provider, then retry.
    expect(
      within(recovery).getByRole("link", { name: "Connect a model" }),
    ).toHaveAttribute("href", "/app/connections");
    expect(within(recovery).getByRole("button", { name: "Try again" })).toBeVisible();
    // The raw technical reason is available but tucked behind a disclosure.
    const technical = within(recovery).getByText("Technical details").closest("details");
    expect(technical).not.toBeNull();
    expect(
      within(technical as HTMLElement).getByText(/OPENAI_API_KEY missing/),
    ).toBeInTheDocument();

    // One authoritative state; no contradiction and no "Operation ended failed".
    expect(screen.getByText("Action needed")).toBeVisible();
    expect(document.body).not.toHaveTextContent(/operation ended failed/i);
    expect(document.body).not.toHaveTextContent(/doing the work/i);
  });

  it("retries a blocked mission through the recovery card's explicit action", async () => {
    const blocked = snapshot();
    blocked.summary.state = "blocked";
    blocked.attention = [connectionRecovery()];
    const fetchMock = installApi({ mission: () => json(blocked) });
    const user = userEvent.setup();
    renderMission();

    await screen.findByRole("region", { name: "Connect an AI model to continue" });
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) => String(input) === "/api/web/missions/mission-42/retry",
        ),
      ).toBe(true),
    );
  });

  it("stops a running mission only after an explicit confirmation step", async () => {
    const fetchMock = installApi();
    const user = userEvent.setup();
    renderMission();

    await screen.findByRole("heading", { level: 1, name: "Prepare the launch" });
    await user.click(screen.getByRole("button", { name: "Stop" }));

    // A confirm step guards the irreversible stop; nothing is sent yet.
    const confirm = await screen.findByRole("button", { name: "Confirm stop" });
    expect(screen.getByRole("button", { name: "Keep going" })).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input) === "/api/web/missions/mission-42/stop",
      ),
    ).toBe(false);

    await user.click(confirm);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) => String(input) === "/api/web/missions/mission-42/stop",
        ),
      ).toBe(true),
    );
  });

  it("keeps the live activity stream collapsed and hides private reasoning until expanded", async () => {
    installApi();
    const user = userEvent.setup();
    renderMission();

    expect(
      await screen.findByRole("heading", { name: "Live progress" }),
    ).toBeVisible();
    expect(
      screen.getByText("Comparing the draft against the launch checklist."),
    ).toBeVisible();

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
    expect(document.body).not.toHaveTextContent("PRIVATE CHAIN OF THOUGHT");
  });

  it("renders explicit empty plan, deliverable and activity states", async () => {
    const empty = snapshot();
    empty.milestones = [];
    empty.recentActivity = [];
    empty.attention = [];
    empty.artifacts = [];
    empty.currentWork = null;
    empty.summary.completedMilestones = 0;
    empty.summary.totalMilestones = 0;
    empty.summary.attentionCount = 0;
    empty.summary.latestActivity = null;
    installApi({ mission: () => json(empty) });
    renderMission();

    expect(
      await screen.findByText("Morrow defines the success checklist as planning completes."),
    ).toBeVisible();
    expect(
      screen.getByText("Files and reports appear here as Morrow produces them."),
    ).toBeVisible();
    expect(screen.getByText("Steps appear here as Morrow works.")).toBeVisible();
    // No "waiting on you" region when there is no attention.
    expect(
      screen.queryByRole("region", { name: "Waiting on you" }),
    ).not.toBeInTheDocument();
  });

  it("shows loading, maps a typed unknown-mission error, and retries the authoritative query", async () => {
    const first = deferred<Response>();
    let missionRequests = 0;
    installApi({
      mission: () => {
        missionRequests += 1;
        return missionRequests === 1 ? first.promise : json(snapshot());
      },
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
    expect(error).toHaveTextContent("Your other missions are unaffected.");
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Prepare the launch" }),
    ).toBeVisible();
    expect(missionRequests).toBe(2);
  });

  it("converts a runtime API failure without exposing raw details and preserves a safe trace", async () => {
    installApi({
      mission: () =>
        json(
          {
            error: {
              code: "RUNTIME_UNAVAILABLE",
              message: "Bearer private-runtime-token at C:\\runtime\\server.ts",
            },
            version: 1,
          },
          503,
          { "x-trace-id": "trace-runtime-42" },
        ),
    });
    renderMission();

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Morrow is not connected");
    expect(error).toHaveTextContent("The local Morrow runtime could not be reached.");
    expect(error).toHaveTextContent("trace-runtime-42");
    expect(error).not.toHaveTextContent("private-runtime-token");
    expect(error).not.toHaveTextContent("server.ts");
    expect(error).not.toHaveTextContent("restarted");
  });

  it("retains synchronized mission data and the live stream when a background refetch fails", async () => {
    let missionRequests = 0;
    installApi({
      mission: () => {
        missionRequests += 1;
        if (missionRequests === 2) {
          return json(
            {
              error: {
                code: "RUNTIME_UNAVAILABLE",
                message: "Bearer private-background-token",
              },
              version: 1,
            },
            503,
          );
        }
        return json(snapshot());
      },
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
    expect(warning).toHaveTextContent("The local Morrow runtime could not be reached.");
    expect(warning).not.toHaveTextContent("private-background-token");
    expect(screen.getByText("Prepare an evidence-backed launch brief.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source?.closed).toBe(false);
    expect(screen.getByText("Live")).toBeVisible();

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
    installApi({
      mission: () => {
        missionRequests += 1;
        return json(missionRequests === 1 ? snapshot() : updated);
      },
    });
    renderMission();

    await screen.findByRole("heading", { name: "Prepare the launch" });
    const source = FakeEventSource.instances[0];
    const announcements = screen.getByLabelText("Mission updates");
    expect(announcements).toBeEmptyDOMElement();

    act(() => source?.emit("open"));
    expect(screen.getByText("Live")).toBeVisible();
    act(() => source?.emit("message", streamEnvelope(1)));
    expect(missionRequests).toBe(1);
    expect(announcements).toBeEmptyDOMElement();
    expect(screen.getByText("Live")).toBeVisible();

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
