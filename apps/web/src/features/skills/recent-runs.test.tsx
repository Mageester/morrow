import type { Routine, ScheduleRun, ScheduleRunStatus } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecentRuns } from "./recent-runs.js";

const routine = { id: "r1", name: "Weekly reporting" } as unknown as Routine;

function run(id: string, status: ScheduleRunStatus, overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  const stamp = new Date(Date.now() - 3 * 3_600_000).toISOString();
  return {
    version: 1, id, scheduleId: "s1", projectId: "p1", routineId: "r1",
    occurrenceAt: stamp, occurrenceKey: id, trigger: "scheduled", status,
    taskId: null, errorCode: null, errorMessage: null, coalesced: false,
    createdAt: stamp, updatedAt: stamp, startedAt: stamp, completedAt: stamp,
    ...overrides,
  } as ScheduleRun;
}

function renderWith(runs: ScheduleRun[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(runs), {
    status: 200, headers: { "content-type": "application/json" },
  })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RecentRuns projectId="p1" routines={[routine]} />
    </QueryClientProvider>,
  );
}

describe("RecentRuns", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("names the routine and states the outcome in plain words", async () => {
    renderWith([run("a", "completed")]);
    expect(await screen.findByText("Weekly reporting")).toBeInTheDocument();
    expect(screen.getByText("Finished")).toBeInTheDocument();
    expect(screen.getByText("3h ago")).toBeInTheDocument();
  });

  it("counts what needs a look, treating approval waits as needing attention", async () => {
    renderWith([run("a", "failed"), run("b", "waiting_for_approval"), run("c", "completed")]);
    expect(await screen.findByRole("status")).toHaveTextContent("2 need a look");
    expect(screen.getByText("Needs you")).toBeInTheDocument();
  });

  it("uses the singular when exactly one run needs attention", async () => {
    renderWith([run("a", "blocked"), run("b", "completed")]);
    expect(await screen.findByRole("status")).toHaveTextContent("1 needs a look");
  });

  it("surfaces the failure reason rather than hiding it behind a drill-down", async () => {
    renderWith([run("a", "failed", { errorMessage: "Provider timed out" })]);
    expect(await screen.findByText("Provider timed out")).toBeInTheDocument();
  });

  it("stays out of the way when nothing has run", async () => {
    const { container } = renderWith([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector(".morrow-recent-runs")).toBeNull();
  });
});
