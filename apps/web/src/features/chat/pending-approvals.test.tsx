import type { Approval } from "@morrow/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./pending-approvals.js";

function approval(details: Record<string, unknown>, summary = "Approval required"): Approval {
  return {
    version: 1,
    id: "approval-1",
    taskId: "task-1",
    projectId: "project-1",
    kind: "command",
    status: "pending",
    summary,
    details,
    decision: null,
    decisionNote: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    resolvedAt: null,
  };
}

describe("ApprovalCard", () => {
  it("shows only the bounded backend-redacted teammate request and one-shot wording", () => {
    render(
      <ApprovalCard
        approval={approval({
          tool: "ask_teammate",
          objective: "Investigate the failing test [redacted]",
          targetAgentName: "Research teammate",
          rawObjective: "do not render this raw objective",
        }, "do not use this raw summary")}
        busy={false}
        error={null}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText("One-shot teammate delegation")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ask Research teammate" })).toBeVisible();
    expect(screen.getByText("Investigate the failing test [redacted]")).toBeVisible();
    expect(screen.getByText(/Allowing starts this teammate request once/)).toBeVisible();
    expect(screen.getByText(/does not create a project-wide trust rule/)).toBeVisible();
    expect(screen.queryByText("do not render this raw objective")).not.toBeInTheDocument();
    expect(screen.queryByText("do not use this raw summary")).not.toBeInTheDocument();
  });

  it("keeps generic approvals unchanged", () => {
    render(
      <ApprovalCard
        approval={approval({ executable: "pnpm", args: ["test"] }, "Run tests")}
        busy={false}
        error={null}
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText("Command · waiting for you")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Run tests" })).toBeVisible();
    expect(screen.queryByText("One-shot teammate delegation")).not.toBeInTheDocument();
  });
});
