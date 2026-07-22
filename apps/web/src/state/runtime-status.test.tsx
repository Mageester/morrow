import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPage } from "../features/placeholders/connections-page.js";
import { MissionStatusSummary } from "./mission-status.js";
import { RuntimeStatusProvider } from "./runtime-status.js";
import type { WebMissionSnapshot } from "@morrow/contracts";

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function healthResponse(service = "morrow-orchestrator"): Response {
  return Response.json({ ok: true, service }, { status: 200 });
}

function renderConnections({ strict = false }: { strict?: boolean } = {}) {
  const content = (
    <RuntimeStatusProvider>
      <ConnectionsPage />
    </RuntimeStatusProvider>
  );
  return render(strict ? <StrictMode>{content}</StrictMode> : content);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RuntimeStatusProvider", () => {
  it("times out a hanging health check and enables another attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderConnections();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking the local Morrow runtime.",
    );
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The local Morrow runtime is unavailable.",
    );
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("aborts the active request during StrictMode cleanup", () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = renderConnections({ strict: true });
    const signals = fetchMock.mock.calls
      .map(([, init]) => init?.signal)
      .filter((signal): signal is AbortSignal => signal !== undefined);

    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.some((signal) => signal.aborted)).toBe(true);

    view.unmount();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps the latest manual or online result when requests finish out of order", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const third = deferred<Response>();
    const fetchMock = vi
      .fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    vi.stubGlobal("fetch", fetchMock);

    renderConnections();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    window.dispatchEvent(new Event("online"));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      third.resolve(healthResponse());
      await third.promise;
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "The local Morrow runtime is connected.",
    );

    await act(async () => {
      first.resolve(new Response(null, { status: 503 }));
      second.resolve(new Response(null, { status: 503 }));
      await Promise.all([first.promise, second.promise]);
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "The local Morrow runtime is connected.",
    );
  });

  it("announces checking-to-result changes in a polite status region", async () => {
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => response.promise));

    renderConnections();

    const visibleStatus = screen.getByRole("status");
    expect(visibleStatus).toHaveAttribute("aria-live", "polite");
    expect(visibleStatus).toHaveTextContent(
      "Checking the local Morrow runtime.",
    );

    await act(async () => {
      response.resolve(healthResponse());
      await response.promise;
    });

    expect(visibleStatus).toHaveTextContent(
      "The local Morrow runtime is connected.",
    );
  });

  it("rejects a health payload for an unexpected service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse("different-service")),
    );

    renderConnections();

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "The local Morrow runtime is unavailable.",
      );
    });
  });

  it("reports reconnecting after an offline browser returns online", async () => {
    const reconnect = deferred<Response>();
    const fetchMock = vi
      .fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(healthResponse())
      .mockImplementationOnce(() => reconnect.promise);
    vi.stubGlobal("fetch", fetchMock);
    renderConnections();
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "The local Morrow runtime is connected.",
      );
    });

    act(() => window.dispatchEvent(new Event("offline")));
    expect(screen.getByRole("status")).toHaveTextContent(
      "The local Morrow runtime is unavailable.",
    );
    act(() => window.dispatchEvent(new Event("online")));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reconnecting to the local Morrow runtime.",
    );

    await act(async () => {
      reconnect.resolve(healthResponse());
      await reconnect.promise;
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "The local Morrow runtime is connected.",
    );
  });
});

function missionSnapshot(
  state: WebMissionSnapshot["summary"]["state"],
  verification: WebMissionSnapshot["verification"]["state"],
  recoverySummary?: string,
): WebMissionSnapshot {
  return {
    artifacts: [],
    attention: [],
    currentWork: null,
    milestones: [],
    recentActivity: recoverySummary
      ? [
          {
            actor: { kind: "system", name: "Morrow" },
            artifactIds: [],
            createdAt: "2026-07-21T14:00:00.000Z",
            cursor: 1,
            detail: "PRIVATE recovery internals",
            id: "recovery-1",
            kind: "recovery",
            missionId: "mission-42",
            summary: recoverySummary,
          },
        ]
      : [],
    summary: {
      attentionCount: 0,
      completedMilestones: 0,
      createdAt: "2026-07-21T13:00:00.000Z",
      currentPhase: "Recorded state",
      id: "mission-42",
      latestActivity: recoverySummary ?? null,
      modelLabel: "claude-sonnet-5",
      objective: "Complete the mission.",
      projectId: "project-1",
      state,
      title: "Mission",
      totalMilestones: 0,
      updatedAt: "2026-07-21T14:00:00.000Z",
      version: 1,
      workspaceId: "workspace-personal-project-1",
    },
    verification: {
      caveats: [],
      evidenceCount: verification === "passed" ? 2 : 0,
      state: verification,
      summary:
        verification === "passed"
          ? "Required evidence passed."
          : "Verification has not passed.",
    },
    version: 1,
  };
}

describe("MissionStatusSummary", () => {
  it.each([
    ["failed_recoverable", "failed", "Failed but recoverable"],
    ["failed", "failed", "Mission failed permanently"],
    [
      "completed_with_caveats",
      "not_ready",
      "Completed, verification incomplete",
    ],
    ["completed_verified", "passed", "Completed and verified"],
  ] as const)(
    "renders %s with %s verification honestly",
    (state, verification, expected) => {
      render(
        <MissionStatusSummary
          snapshot={missionSnapshot(state, verification)}
        />,
      );
      expect(screen.getByRole("heading", { name: expected })).toBeVisible();
    },
  );

  it("renders a browser-safe interrupted/resumed recovery record without private detail or invented checkpoint data", () => {
    render(
      <MissionStatusSummary
        snapshot={missionSnapshot(
          "working",
          "in_progress",
          "Resumed after the local runtime interrupted the mission.",
        )}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Recovery recorded" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Resumed after the local runtime interrupted the mission.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/PRIVATE recovery internals/i)).not.toBeInTheDocument();
    expect(screen.getByText(/checkpoint and replay details were not reported/i)).toBeVisible();
  });

  it.each([
    ["passed", "Passed"],
    ["passed_with_caveats", "Passed with caveats"],
  ] as const)(
    "reports only current %s snapshot verification after recovery",
    (verification, label) => {
      render(
        <MissionStatusSummary
          snapshot={missionSnapshot(
            "working",
            verification,
            "Resumed from a recorded interruption.",
          )}
        />,
      );

      const recoverySurface = screen.getByRole("heading", {
        name: "Recovery recorded",
      }).parentElement;
      expect(recoverySurface).toHaveTextContent(
        `Current snapshot verification: ${label}.`,
      );
      expect(recoverySurface).toHaveTextContent(
        /post-recovery verification trust was not reported/i,
      );
      expect(document.body).not.toHaveTextContent(
        /remains passed|retains recorded/i,
      );
    },
  );
});
