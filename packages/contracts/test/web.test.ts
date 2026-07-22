import { describe, expect, it } from "vitest";
import {
  CreateWebMissionSchema,
  WebMissionSnapshotSchema,
  WebMissionStreamEnvelopeSchema,
} from "../src/web.js";

describe("web mission contracts", () => {
  it("accepts a general mission without a task category", () => {
    expect(CreateWebMissionSchema.parse({
      objective: "Research the market, create a report, and prepare slides.",
      projectId: "project-1",
      autonomy: "recommended",
    })).toEqual({
      objective: "Research the market, create a report, and prepare slides.",
      projectId: "project-1",
      autonomy: "recommended",
    });
  });

  it("rejects fabricated numeric progress", () => {
    const snapshot = {
      version: 1,
      summary: {
        version: 1,
        id: "mission-1",
        projectId: "project-1",
        workspaceId: "project-1",
        title: "Market analysis",
        objective: "Analyze the market",
        state: "working",
        currentPhase: "Researching",
        modelLabel: "balanced preset",
        latestActivity: "Reviewed competitor sites",
        attentionCount: 0,
        completedMilestones: 1,
        totalMilestones: 3,
        createdAt: "2026-07-19T12:00:00.000Z",
        updatedAt: "2026-07-19T12:01:00.000Z",
      },
      milestones: [],
      currentWork: "Reviewing sources",
      recentActivity: [],
      attention: [],
      artifacts: [],
      verification: { state: "not_ready", summary: "Work is still running", evidenceCount: 0, caveats: [] },
    };
    expect(WebMissionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => WebMissionSnapshotSchema.parse({ ...snapshot, progressPercent: 50 })).toThrow();
  });

  it("requires an ordered positive stream cursor", () => {
    expect(WebMissionStreamEnvelopeSchema.parse({
      version: 1,
      cursor: 4,
      missionId: "mission-1",
      eventType: "mission.updated",
      emittedAt: "2026-07-19T12:02:00.000Z",
      payload: { changed: true },
    }).cursor).toBe(4);
  });
});
