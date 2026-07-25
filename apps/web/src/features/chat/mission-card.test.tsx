import type { WebMissionSummary } from "@morrow/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MissionCard } from "./mission-card.js";

const NOW = "2026-07-22T12:00:00.000Z";

function summary(over: Partial<WebMissionSummary> = {}): WebMissionSummary {
  return {
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
    completedMilestones: 3,
    totalMilestones: 8,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe("MissionCard", () => {
  it("shows a humanized state, progress, and a details toggle", async () => {
    const onToggle = vi.fn();
    render(<MissionCard expanded={false} onToggle={onToggle} summary={summary()} />);

    expect(screen.getByText("Build the chat-first dashboard")).toBeVisible();
    expect(screen.getByText(/3 of 8 steps/)).toBeVisible();
    expect(screen.getByText("Working")).toBeVisible();

    const toggle = screen.getByRole("button", { name: "View details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("flags a mission that needs the user", () => {
    render(<MissionCard expanded onToggle={vi.fn()} summary={summary({ state: "needs_input", attentionCount: 1 })} />);
    expect(screen.getByText("Needs you")).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
  });
});
