import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutinesPanel } from "./routines-panel.js";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../roster/teammate-avatar.js", () => ({
  TeammateAvatar: ({ name }: { name: string }) => <span aria-label={`${name} avatar`} />,
}));
vi.mock("../roster/use-thread-teammate.js", () => ({
  useThreadTeammate: (_projectId: string, _agentId: string | null) => ({ name: "Reporter" }),
}));

const routine = {
  version: 1,
  id: "routine-1",
  projectId: "project-1",
  agentId: "agent-reporter",
  name: "Weekly report",
  objective: "Summarise the week.",
  steps: [{ summary: "Read the changelog", target: "CHANGELOG.md", toolName: "read_file" }],
  sourceConversationId: "conversation-1",
  runCount: 2,
  lastRunAt: "2026-08-19T12:00:00.000Z",
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-19T12:00:00.000Z",
};

function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <RoutinesPanel projectId="project-1" />
    </QueryClientProvider>,
  );
}

describe("RoutinesPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("edits definition fields while keeping the saved run history visible", async () => {
    // Routed by URL rather than by call order: the panel's read queries are an
    // implementation detail, and an ordered mock chain silently hands the wrong
    // response to the wrong request the moment one is added.
    const updated = { ...routine, name: "Monthly report", objective: "Review the month." };
    let saved = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.method === "PATCH") { saved = true; return Response.json(updated); }
      if (url.includes("/schedule-runs")) return Response.json([]);
      if (url.includes("/schedules")) return Response.json([]);
      return Response.json([saved ? updated : routine]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText("Weekly report")).toBeVisible();
    expect(screen.getByText(/2 runs/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Edit Weekly report" }));
    expect(screen.getByLabelText("Routine name")).toHaveValue("Weekly report");

    await user.clear(screen.getByLabelText("Routine name"));
    await user.type(screen.getByLabelText("Routine name"), "Monthly report");
    await user.clear(screen.getByLabelText("Purpose"));
    await user.type(screen.getByLabelText("Purpose"), "Review the month.");
    await user.clear(screen.getByLabelText("Routine step 1"));
    await user.type(screen.getByLabelText("Routine step 1"), "Read the monthly changelog");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const patched = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === "PATCH");
      expect(call).toBeTruthy();
      return call as unknown as [RequestInfo, RequestInit];
    });
    const [target, init] = patched;
    expect(String(target)).toBe("/api/projects/project-1/routines/routine-1");
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "Monthly report",
      objective: "Review the month.",
      steps: [{ summary: "Read the monthly changelog", target: "CHANGELOG.md", toolName: "read_file" }],
    });
    expect(screen.getByText(/2 runs/)).toBeVisible();
  });

  it("renders update errors instead of silently dropping an edit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ version: 1, error: { code: "OFFLINE", message: "Routine service is offline." } }), { status: 503 });
      }
      if (url.includes("/schedule-runs") || url.includes("/schedules")) return Response.json([]);
      return Response.json([routine]);
    }));
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Edit Weekly report" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Routine service is offline.");
  });
});
