import type { WebAttentionRequest, WebMissionSnapshot } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { missionKeys } from "../../api/query-keys.js";
import { MissionPanel } from "./mission-panel.js";

const NOW = "2026-07-22T12:00:00.000Z";

const snapshot: WebMissionSnapshot = {
  version: 1,
  summary: {
    version: 1,
    id: "m1",
    projectId: "p1",
    workspaceId: "w1",
    conversationId: "c1",
    title: "Build the chat-first dashboard",
    objective: "Redesign Morrow",
    state: "working",
    currentPhase: "Implementing the chat experience",
    modelLabel: "Claude Opus",
    latestActivity: null,
    attentionCount: 0,
    completedMilestones: 1,
    totalMilestones: 3,
    createdAt: NOW,
    updatedAt: NOW,
  },
  milestones: [
    { id: "s1", title: "Review the existing experience", state: "completed", evidenceIds: [] },
    { id: "s2", title: "Implement the chat experience", state: "running", evidenceIds: [] },
    { id: "s3", title: "Run browser acceptance", state: "pending", evidenceIds: [] },
  ],
  currentWork: "Wiring the conversation composer",
  recentActivity: [
    {
      id: "a1",
      missionId: "m1",
      cursor: 1,
      kind: "progress",
      summary: "Finished the application shell",
      detail: null,
      actor: { kind: "morrow", name: "Morrow" },
      artifactIds: [],
      createdAt: NOW,
    },
  ],
  attention: [],
  artifacts: [],
  verification: { state: "in_progress", summary: "Browser acceptance will run before completion.", evidenceCount: 0, caveats: [] },
};

function planApprovalAttention(): WebAttentionRequest {
  return {
    id: "m1:plan-approval",
    missionId: "m1",
    kind: "approval",
    title: "Review and approve the plan",
    explanation: "Morrow proposes 3 success requirements for this mission.",
    recommendation: "Approve to start the work, request changes, or decline to cancel the mission.",
    choices: [
      { id: "approve", label: "Approve and start", description: "Morrow begins working immediately.", recommended: true, destructive: false, requiresNote: false },
      { id: "adjust", label: "Request changes", description: "Add what should change in the note above, then choose this.", recommended: false, destructive: false, requiresNote: true },
      { id: "deny", label: "Cancel mission", description: "Stops this mission.", recommended: false, destructive: true, requiresNote: false },
    ],
    canContinueElsewhere: false,
    createdAt: NOW,
  };
}

function awaitingApprovalSnapshot(): WebMissionSnapshot {
  return {
    ...snapshot,
    summary: { ...snapshot.summary, state: "needs_input", currentPhase: "Waiting for you to approve the plan", attentionCount: 1 },
    attention: [planApprovalAttention()],
  };
}

describe("MissionPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the plan, current work, verification, and model", () => {
    render(<MissionPanel snapshot={snapshot} />);

    expect(screen.getByText("Review the existing experience")).toBeVisible();
    expect(screen.getByText("Implement the chat experience")).toBeVisible();
    expect(screen.getByText("Run browser acceptance")).toBeVisible();
    expect(screen.getByText("Wiring the conversation composer")).toBeVisible();
    expect(screen.getByText("Browser acceptance will run before completion.")).toBeVisible();
    expect(screen.getByText("Claude Opus")).toBeVisible();
    expect(screen.getByText("Finished the application shell")).toBeVisible();
  });

  it("lets the user approve, request changes, or cancel a proposed plan without leaving the panel", async () => {
    const requestedNote = { value: "" };
    const revised: WebMissionSnapshot = {
      ...awaitingApprovalSnapshot(),
      milestones: [{ id: "s4", title: "Revised: add a dark-mode toggle first", state: "pending", evidenceIds: [] }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/web/missions/m1/attention/${encodeURIComponent("m1:plan-approval")}/resolve` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { choiceId: string; note?: string };
        requestedNote.value = body.note ?? "";
        if (body.choiceId === "adjust") return Response.json(revised);
        throw new Error(`unexpected choice ${body.choiceId}`);
      }
      throw new Error(`unexpected request ${init?.method} ${url}`);
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // Seeded so the mutation's cache-generation guard (shared across the app's
    // mission surfaces) has a real baseline to compare against and commit over.
    queryClient.setQueryData(missionKeys.detail("m1"), awaitingApprovalSnapshot());
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MissionPanel snapshot={awaitingApprovalSnapshot()} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Review and approve the plan")).toBeVisible();
    const requestChanges = screen.getByRole("button", { name: "Request changes" });
    expect(requestChanges).toBeDisabled();

    await user.type(screen.getByLabelText("Decision note"), "Add a dark-mode toggle first");
    expect(requestChanges).toBeEnabled();
    await user.click(requestChanges);

    await waitFor(() => expect(requestedNote.value).toBe("Add a dark-mode toggle first"));
    await waitFor(() =>
      expect(queryClient.getQueryData(missionKeys.detail("m1"))).toEqual(revised),
    );
  });
});
