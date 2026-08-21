import type { ThreadHandoff } from "@morrow/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffRow } from "./handoff-row.js";

const startedAt = "2026-08-20T11:59:00.000Z";
const completedAt = "2026-08-20T12:00:00.000Z";

function handoff(overrides: Partial<ThreadHandoff> = {}): ThreadHandoff {
  return {
    version: 1,
    id: "handoff-1",
    parentTaskId: "task-parent",
    agentId: "agent-research",
    agentName: "Research",
    status: "completed",
    objective: "Check the release notes for the export format.",
    result: "The release notes document the export format.",
    evidenceRef: "task:child-1",
    conversationId: "conversation-child",
    toolCount: 2,
    startedAt,
    completedAt,
    ...overrides,
  };
}

function renderRow(value = handoff()) {
  const root = createRootRoute({ component: () => <><HandoffRow handoff={value} projectId="project-1" /><Outlet /></> });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/chats/$conversationId",
    validateSearch: (search: Record<string, unknown>) => ({ projectId: search.projectId as string }),
    component: () => <p>child thread</p>,
  });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({ history, routeTree: root.addChildren([index, chat]) });
  render(<RouterProvider router={router as AnyRouter} />);
  return { history };
}

describe("HandoffRow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("attributes a completed handoff, expands its safe result, and links to the evidence thread", async () => {
    const value = handoff({ completedAt });
    const { history } = renderRow(value);
    const user = userEvent.setup();
    const row = await screen.findByTestId("thread-handoff");
    const head = within(row).getByRole("button");

    expect(row).toHaveAttribute("data-status", "completed");
    expect(head).toHaveAccessibleName(/Research replied.*Check the release notes.*2 tools/);
    expect(within(row).queryByText(completedAt)).not.toBeInTheDocument();

    await user.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByText("Research said")).toBeVisible();
    expect(within(row).getByText(value.result!)).toBeVisible();
    // The projection supplies an evidence handle, not model arguments or
    // private provider text. The row should never turn that handle into
    // transcript content.
    expect(within(row).queryByText(value.evidenceRef!)).not.toBeInTheDocument();
    expect(within(row).queryByText(/hidden reasoning|provider secret/i)).not.toBeInTheDocument();

    const link = within(row).getByRole("link", { name: "Open Research's thread" });
    expect(link).toHaveAttribute("href", "/chats/conversation-child?projectId=project-1");
    await user.click(link);
    await waitFor(() => expect(history.location.href).toBe("/chats/conversation-child?projectId=project-1"));
  });

  const statusCases: Array<[ThreadHandoff["status"], RegExp, string]> = [
    ["queued", /Asking Research…/, "Research has not answered yet."],
    ["running", /Asking Research…/, "Research has not answered yet."],
    ["failed", /Research could not finish/, "Research left no answer."],
    ["cancelled", /Research was stopped/, "Research left no answer."],
  ];

  it.each(statusCases)("communicates %s status in text and state", async (status, label, emptyResult) => {
    const user = userEvent.setup();
    const rowValue = handoff({ status, result: null, conversationId: null, completedAt: null });
    renderRow(rowValue);
    const row = await screen.findByTestId("thread-handoff");
    const head = within(row).getByRole("button");

    expect(row).toHaveAttribute("data-status", status);
    expect(head).toHaveAccessibleName(expect.stringMatching(label));
    await user.click(head);
    expect(within(row).getByText(emptyResult)).toBeVisible();
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
  });
});
