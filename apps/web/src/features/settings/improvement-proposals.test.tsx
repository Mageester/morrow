import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ImprovementProposal } from "@morrow/contracts";
import { ImprovementProposals } from "./improvement-proposals.js";

const proposal: ImprovementProposal = {
  id: "proposal-1",
  version: 1,
  observedProblem: "Read-only tasks include unrelated tool schemas.",
  proposedChange: { kind: "tool-profile", description: "Use read-only-workspace.", profile: "read-only-workspace" },
  evidenceTaskIds: ["task-1"],
  benchmarkFixtureIds: ["fixture-1"],
  expectedEffect: { metric: "tool_schema_tokens", baseline: 100, target: 50, acceptanceCriterion: "No regression." },
  privacyImpact: { summary: "No authority change.", networkAccess: "unchanged", permissionChange: "none" },
  rolloutState: "proposed",
  rollbackReference: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
};

const shadowEvaluation = {
  proposalId: "proposal-evaluated",
  proposalVersion: 1,
  mode: "shadow" as const,
  fixtureId: "fixture-1",
  baseline: { outcome: "passed" as const, privacy: "passed" as const, reliability: "passed" as const, verification: "passed" as const, toolSchemaTokens: 100 },
  candidate: { outcome: "passed" as const, privacy: "passed" as const, reliability: "passed" as const, verification: "passed" as const, toolSchemaTokens: 50 },
  promotable: true,
  reason: "candidate met the stated acceptance criterion",
  evaluatedAt: "2026-08-11T12:01:00.000Z",
};

describe("improvement proposal review", () => {
  it("shows the change, evidence, expected trade-off, privacy impact, and current test result", () => {
    render(<ImprovementProposals proposals={[proposal]} onApprove={vi.fn()} onReject={vi.fn()} onRollback={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /harness improvements/i })).toBeInTheDocument();
    expect(screen.getByText(proposal.observedProblem)).toBeInTheDocument();
    expect(screen.getByText(/fixture-1/)).toBeInTheDocument();
    expect(screen.getByText(/tool_schema_tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/no authority change/i)).toBeInTheDocument();
    expect(screen.getByText(/awaiting evaluation|proposed/i)).toBeInTheDocument();
  });

  it("makes approval, rejection, and rollback explicit user actions", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onRollback = vi.fn();
    const evaluated = { ...proposal, id: "proposal-evaluated", rolloutState: "evaluated" as const, evaluation: shadowEvaluation };
    const approved = { ...evaluated, id: "proposal-approved", rolloutState: "approved" as const, evaluation: { ...shadowEvaluation, proposalId: "proposal-approved" } };
    const pending = { ...proposal, id: "proposal-pending" };
    render(<ImprovementProposals proposals={[evaluated, approved, pending]} onApprove={onApprove} onReject={onReject} onRollback={onRollback} />);

    const articles = screen.getAllByRole("article");
    const evaluatedArticle = articles[0]!;
    const approvedArticle = articles[1]!;
    const pendingArticle = articles[2]!;
    await user.click(within(evaluatedArticle).getByRole("button", { name: /approve/i }));
    await user.click(within(pendingArticle).getByRole("button", { name: /reject/i }));
    await user.click(within(approvedArticle).getByRole("button", { name: /rollback/i }));

    expect(onApprove).toHaveBeenCalledWith("proposal-evaluated");
    expect(onReject).toHaveBeenCalledWith("proposal-pending");
    expect(onRollback).toHaveBeenCalledWith("proposal-approved");
  });
});
