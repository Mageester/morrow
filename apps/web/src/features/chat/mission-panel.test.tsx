import type { WebMissionSnapshot } from "@morrow/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

describe("MissionPanel", () => {
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
});
