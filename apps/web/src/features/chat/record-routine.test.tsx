import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordRoutine } from "./record-routine.js";

const recordingStart = "2026-08-20T12:00:00.000Z";
const recordingEnd = "2026-08-20T12:01:00.000Z";

const proposal = {
  version: 1 as const,
  conversationId: "conversation-1",
  agentId: "agent-reporter",
  suggestedName: "Weekly report",
  objective: "Summarise what changed this week.",
  steps: [{ summary: "Read the changelog", target: "CHANGELOG.md", toolName: "read_file" }],
  taskCount: 1,
};

function state(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    recording: {
      version: 1,
      id: "recording-1",
      conversationId: "conversation-1",
      agentId: "agent-reporter",
      routineId: null,
      startedAt: recordingStart,
      stoppedAt: recordingEnd,
    },
    proposal,
    ...overrides,
  };
}

function openState() {
  return state({
    recording: {
      version: 1,
      id: "recording-1",
      conversationId: "conversation-1",
      agentId: "agent-reporter",
      routineId: null,
      startedAt: recordingStart,
      stoppedAt: null,
    },
    proposal: null,
  });
}

function renderRecord() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <RecordRoutine agentId="agent-reporter" conversationId="conversation-1" projectId="project-1" />
    </QueryClientProvider>,
  );
}

function apiError(message: string, code = "RECORDING_FAILED") {
  return new Response(JSON.stringify({ version: 1, error: { code, message } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

describe("RecordRoutine", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rehydrates a closed proposal and exposes editable purpose and observed steps", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(state())));
    renderRecord();

    expect(await screen.findByRole("heading", { name: "Keep this as a routine?" })).toBeVisible();
    expect(screen.getByLabelText("Purpose")).toHaveValue(proposal.objective);
    expect(screen.getByLabelText("Routine name")).toHaveValue(proposal.suggestedName);
    expect(screen.getByLabelText("Observed step 1")).toHaveValue(proposal.steps[0]!.summary);
    expect(screen.getByText(/Observed 1 task/)).toBeVisible();
    expect(screen.getByText(/Runs as your teammate/)).toBeVisible();
  });

  it("derives the active timer from the persisted recording start", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-08-20T12:01:05.000Z").getTime());
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(openState())));
    renderRecord();

    expect(await screen.findByText("Watching and learning")).toBeVisible();
    expect(screen.getByText("01:05")).toBeVisible();
  });

  it("shows a start failure in the recording surface", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/recording") && init?.method === "POST") return apiError("Could not start watching.");
      return Response.json({ version: 1, recording: null, proposal: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderRecord();

    await user.click(await screen.findByRole("button", { name: /Record a routine/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not start watching.");
  });

  it("shows a stop failure in the recording surface", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return apiError("Could not stop watching.");
      return Response.json(openState());
    }));
    const user = userEvent.setup();
    renderRecord();
    expect(await screen.findByText("Watching and learning")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Stop recording/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not stop watching.");
  });

  it("does not show the empty-span message after saving a proposal", async () => {
    const savedRoutine = {
      version: 1,
      id: "routine-1",
      projectId: "project-1",
      agentId: "agent-reporter",
      name: proposal.suggestedName,
      objective: proposal.objective,
      steps: proposal.steps,
      sourceConversationId: "conversation-1",
      runCount: 0,
      lastRunAt: null,
      createdAt: recordingStart,
      updatedAt: recordingEnd,
    };
    let recordingGets = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/roster")) return Response.json({ version: 1, projectId: "project-1", entries: [] });
      if (init?.method === "POST" && url.endsWith("/recording")) return Response.json(openState(), { status: 201 });
      if (init?.method === "DELETE") return Response.json({ version: 1, recording: { ...openState().recording, stoppedAt: recordingEnd }, proposal }, { status: 200 });
      if (init?.method === "POST" && url.endsWith("/routines")) return Response.json(savedRoutine, { status: 201 });
      if (url.endsWith("/recording")) {
        recordingGets += 1;
        if (recordingGets === 1) return Response.json({ version: 1, recording: null, proposal: null });
        if (recordingGets === 2) return Response.json(openState());
        return Response.json({ version: 1, recording: { ...openState().recording, stoppedAt: recordingEnd, routineId: "routine-1" }, proposal: null });
      }
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderRecord();

    await user.click(await screen.findByRole("button", { name: /Record a routine/ }));
    await user.click(await screen.findByRole("button", { name: /Stop recording/ }));
    expect(await screen.findByRole("heading", { name: "Keep this as a routine?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save routine" }));

    await waitFor(() => expect(screen.queryByText(/Nothing was recorded/)).not.toBeInTheDocument());
  });

  it("sends edited steps and purpose when saving the proposal", async () => {
    const saved = {
        version: 1,
        id: "routine-1",
        projectId: "project-1",
        agentId: "agent-reporter",
        name: "Updated report",
        objective: "Review the week.",
        steps: [{ summary: "Review the changelog", target: "CHANGELOG.md", toolName: "read_file" }],
        sourceConversationId: "conversation-1",
        runCount: 0,
        lastRunAt: null,
        createdAt: recordingStart,
        updatedAt: recordingEnd,
      };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/roster")) return Response.json({ version: 1, projectId: "project-1", entries: [] });
      if (init?.method === "PATCH" || init?.method === "POST") return Response.json(saved, { status: 201 });
      if (url.endsWith("/recording")) return Response.json(state());
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderRecord();

    await user.clear(await screen.findByLabelText("Routine name"));
    await user.type(screen.getByLabelText("Routine name"), "Updated report");
    await user.clear(screen.getByLabelText("Purpose"));
    await user.type(screen.getByLabelText("Purpose"), "Review the week.");
    await user.clear(screen.getByLabelText("Observed step 1"));
    await user.type(screen.getByLabelText("Observed step 1"), "Review the changelog");
    await user.click(screen.getByRole("button", { name: "Save routine" }));

    const saveCall = fetchMock.mock.calls.find(([input, init]) => init?.method === "POST" && String(input).endsWith("/routines"));
    expect(saveCall).toBeDefined();
    const init = saveCall![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "Updated report",
      objective: "Review the week.",
      steps: [{ summary: "Review the changelog", target: "CHANGELOG.md", toolName: "read_file" }],
    });
  });

  it("renders the idle state without a timer or proposal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: 1, recording: null, proposal: null })));
    renderRecord();

    const toggle = await screen.findByRole("button", { name: "Record a routine" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).not.toHaveAttribute("data-recording");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Keep this as a routine?" })).not.toBeInTheDocument();
  });

  it("keeps the proposal open and explains a save failure", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/routines") && init?.method === "POST") {
        return apiError("Could not save this routine.", "ROUTINE_SAVE_FAILED");
      }
      return Response.json(state());
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderRecord();

    await user.click(await screen.findByRole("button", { name: "Save routine" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save this routine.");
    expect(screen.getByRole("heading", { name: "Keep this as a routine?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save routine" })).toBeEnabled();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/routines") && init?.method === "POST")).toBe(true);
  });
});
