import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutineSchedulesPanel } from "./routine-schedules-panel.js";

const routine = {
  version: 1 as const,
  id: "routine-1",
  projectId: "project-1",
  agentId: "agent-1",
  name: "Weekly report",
  objective: "Summarise the week.",
  steps: [],
  sourceConversationId: null,
  runCount: 0,
  lastRunAt: null,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
};

const schedule = {
  version: 1 as const,
  id: "schedule-1",
  projectId: "project-1",
  cron: "0 9 * * 1-5",
  taskKind: "routine" as const,
  routineId: "routine-1",
  agentId: "agent-1",
  enabled: true,
  lastRunAt: null,
  nextRunAt: "2026-08-21T09:00:00.000Z",
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
};

function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <RoutineSchedulesPanel projectId="project-1" routines={[routine]} />
    </QueryClientProvider>,
  );
}

describe("RoutineSchedulesPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows pause, manual run, and redacted run history controls", async () => {
    const run = {
      version: 1 as const,
      id: "run-1",
      scheduleId: "schedule-1",
      projectId: "project-1",
      routineId: "routine-1",
      occurrenceAt: "2026-08-20T09:00:00.000Z",
      occurrenceKey: "2026-08-20T09:00:00.000Z",
      trigger: "scheduled" as const,
      status: "waiting_for_approval" as const,
      taskId: "task-1",
      errorCode: null,
      errorMessage: null,
      coalesced: false,
      createdAt: "2026-08-20T09:00:00.000Z",
      updatedAt: "2026-08-20T09:00:00.000Z",
      startedAt: null,
      completedAt: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([schedule]))
      .mockResolvedValueOnce(Response.json([run]))
      .mockResolvedValueOnce(Response.json(schedule))
      .mockResolvedValue(Response.json([{ ...schedule, enabled: false }]));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText(/Active · 0 9/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText(/Waiting for approval/)).toBeVisible();
    expect(screen.queryByText(/secret|provider output/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/pause"))).toBe(true));
  });

  it("sends project ownership with manual runs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([schedule]))
      .mockResolvedValue(Response.json({ version: 1, scheduleId: "schedule-1", runId: "run-1", taskId: "task-1", conversationId: "conversation-1", projectId: "project-1", aggregateUrl: "/api/tasks/task-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/run"))).toBe(true));
    const call = fetchMock.mock.calls.find(([path]) => String(path).includes("/run"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ projectId: "project-1" });
  });
});
