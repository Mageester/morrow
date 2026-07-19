import { describe, it, expect } from "vitest";
import type { z } from "zod";
import {
  MissionSchema,
  WebMissionSnapshotSchema,
  WebMissionSummarySchema,
  type Approval,
  type Mission,
  type MissionCriterion,
  type MissionEvent,
  type MissionEvidence,
} from "@morrow/contracts";
import type { GuardianDecision } from "../src/mission/guardian.js";
import {
  projectMissionForWeb,
  projectMissionSummaryForWeb,
  type MissionWebProjectionInput,
} from "../src/web/mission-projection.js";

const PROJECT_ID = "project-1";
const WORKSPACE_ID = "workspace-1";
const T0 = "2026-07-19T10:00:00.000Z";
const T1 = "2026-07-19T10:05:00.000Z";
const T2 = "2026-07-19T10:10:00.000Z";

function criterion(overrides: Partial<MissionCriterion> & Pick<MissionCriterion, "id" | "state">): MissionCriterion {
  return {
    missionId: "mission-1",
    order: 0,
    description: `Criterion ${overrides.id}`,
    verification: { kind: "test", command: "pnpm test" },
    evidenceIds: [],
    failureReason: null,
    waiverReason: null,
    createdAt: T0,
    updatedAt: T1,
    ...overrides,
  };
}

function evidence(overrides: Partial<MissionEvidence> & Pick<MissionEvidence, "id">): MissionEvidence {
  return {
    missionId: "mission-1",
    criterionIds: [],
    type: "test",
    summary: `Evidence ${overrides.id}`,
    command: null,
    exitCode: null,
    outputRef: null,
    artifactPath: null,
    status: "passed",
    recordedAt: T1,
    ...overrides,
  };
}

function event(sequence: number, type: MissionEvent["type"], summary: string, createdAt = T1): MissionEvent {
  return { id: `event-${sequence}`, missionId: "mission-1", sequence, type, summary, data: {}, createdAt };
}

function mission(overrides: Partial<z.input<typeof MissionSchema>>): Mission {
  return MissionSchema.parse({
    version: 1,
    id: "mission-1",
    projectId: PROJECT_ID,
    objective: "Ship the honest web mission projection so the UI never lies about progress.",
    status: "running",
    budget: {},
    createdAt: T0,
    updatedAt: T2,
    ...overrides,
  });
}

const passingGuardian: GuardianDecision = {
  passed: true,
  missing: [],
  failed: [],
  blocked: [],
  nextActions: [],
  evidenceSnapshot: {
    missionId: "mission-1",
    criteria: { total: 2, satisfied: 2 },
    requirements: { authoritative: 0, satisfied: 0 },
    evidence: { passed: 2, failed: 0, inconclusive: 0 },
    operations: { resolved: 0, unresolved: 0 },
    tasks: { resolved: 0, unresolved: 0 },
    approvals: { resolved: 0, unresolved: 0 },
    validation: { required: [], completed: [] },
    changedFiles: [],
  },
};

const blockedGuardian: GuardianDecision = {
  passed: false,
  missing: [],
  failed: [],
  blocked: [{ kind: "approval", id: "approval-1", detail: "Approval is pending." }],
  nextActions: ["resolve_approvals"],
  evidenceSnapshot: {
    missionId: "mission-1",
    criteria: { total: 2, satisfied: 1 },
    requirements: { authoritative: 0, satisfied: 0 },
    evidence: { passed: 1, failed: 0, inconclusive: 0 },
    operations: { resolved: 0, unresolved: 0 },
    tasks: { resolved: 0, unresolved: 0 },
    approvals: { resolved: 0, unresolved: 1 },
    validation: { required: [], completed: [] },
    changedFiles: [],
  },
};

const runningFixture: MissionWebProjectionInput = {
  workspaceId: WORKSPACE_ID,
  mission: mission({
    status: "running",
    criteria: [
      criterion({ id: "c1", order: 0, state: "verified", evidenceIds: ["ev1"] }),
      criterion({ id: "c2", order: 1, state: "in_progress" }),
    ],
    evidence: [evidence({ id: "ev1", criterionIds: ["c1"], status: "passed" })],
  }),
  events: [
    event(1, "mission.created", "Mission created"),
    event(2, "mission.started", "Mission started"),
    event(3, "mission.criterion_verified", "Criterion c1 verified"),
  ],
  guardian: null,
};

const pendingApproval: Approval = {
  version: 1,
  id: "approval-1",
  taskId: "task-1",
  projectId: PROJECT_ID,
  kind: "command",
  status: "pending",
  summary: "Run destructive migration against production database",
  details: {},
  decision: null,
  decisionNote: null,
  createdAt: T1,
  resolvedAt: null,
};

const blockedFixture: MissionWebProjectionInput = {
  workspaceId: WORKSPACE_ID,
  mission: mission({
    status: "blocked",
    criteria: [
      criterion({ id: "c1", order: 0, state: "verified", evidenceIds: ["ev1"] }),
      criterion({ id: "c2", order: 1, state: "in_progress" }),
    ],
    evidence: [evidence({ id: "ev1", criterionIds: ["c1"], status: "passed" })],
  }),
  events: [
    event(1, "mission.created", "Mission created"),
    event(2, "mission.status_changed", "Mission blocked awaiting approval"),
  ],
  guardian: blockedGuardian,
  pendingApprovals: [pendingApproval],
};

const completedFixture: MissionWebProjectionInput = {
  workspaceId: WORKSPACE_ID,
  mission: mission({
    status: "completed",
    completedAt: T2,
    criteria: [
      criterion({ id: "c1", order: 0, state: "verified", evidenceIds: ["ev1"] }),
      criterion({ id: "c2", order: 1, state: "verified", evidenceIds: ["ev2"] }),
    ],
    evidence: [
      evidence({ id: "ev1", criterionIds: ["c1"], status: "passed", artifactPath: "artifacts/report.md", type: "artifact" }),
      evidence({ id: "ev2", criterionIds: ["c2"], status: "passed" }),
    ],
    result: {
      status: "completed",
      objective: "Ship the honest web mission projection.",
      criteriaVerified: 2,
      criteriaFailed: 0,
      criteriaUnverified: 0,
      criteriaWaived: 0,
      criteriaTotal: 2,
      summary: "All criteria verified with direct evidence.",
      artifacts: ["artifacts/final-diff.patch"],
    },
  }),
  events: [
    event(1, "mission.created", "Mission created"),
    event(2, "mission.started", "Mission started"),
    event(3, "mission.criterion_verified", "Criterion c1 verified"),
    event(4, "mission.criterion_verified", "Criterion c2 verified"),
    event(5, "mission.completed", "Mission completed", T2),
  ],
  guardian: passingGuardian,
};

describe("projectMissionForWeb", () => {
  it("projects a running mission as working with honest milestone counts", () => {
    const snapshot = projectMissionForWeb(runningFixture);
    expect(snapshot.summary.state).toBe("working");
    expect(snapshot.summary.completedMilestones).toBe(1);
    expect(snapshot.summary.totalMilestones).toBe(2);
    expect(() => WebMissionSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("projects a blocked mission with a leading blocker attention request", () => {
    const snapshot = projectMissionForWeb(blockedFixture);
    expect(snapshot.summary.state).toBe("blocked");
    expect(snapshot.attention[0]?.kind).toBe("blocker");
    expect(snapshot.summary.attentionCount).toBe(snapshot.attention.length);
    expect(() => WebMissionSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("projects a completed+verified mission as passed with artifacts from evidence", () => {
    const snapshot = projectMissionForWeb(completedFixture);
    expect(snapshot.summary.state).toBe("completed_verified");
    expect(snapshot.verification.state).toBe("passed");
    expect(snapshot.artifacts.some((a) => a.openPath === "artifacts/report.md")).toBe(true);
    expect(snapshot.artifacts.some((a) => a.openPath === "artifacts/final-diff.patch")).toBe(true);
    expect(() => WebMissionSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("maps criterion state to milestone state without inventing percentages", () => {
    const snapshot = projectMissionForWeb(runningFixture);
    const states = snapshot.milestones.map((m) => m.state);
    expect(states).toEqual(["completed", "running"]);
  });

  it("orders activity by event sequence and uses the sequence as a positive cursor", () => {
    const snapshot = projectMissionForWeb(completedFixture);
    expect(snapshot.recentActivity.map((a) => a.cursor)).toEqual([1, 2, 3, 4, 5]);
    for (const activity of snapshot.recentActivity) {
      expect(activity.cursor).toBeGreaterThan(0);
    }
  });

  it("keeps a completed headline coherent when a failed criterion survives despite a passing guardian", () => {
    const incoherentFixture: MissionWebProjectionInput = {
      workspaceId: WORKSPACE_ID,
      mission: mission({
        status: "completed",
        completedAt: T2,
        criteria: [
          criterion({ id: "c1", order: 0, state: "verified", evidenceIds: ["ev1"] }),
          criterion({ id: "c2", order: 1, state: "failed", failureReason: "Regression left a test red" }),
        ],
        evidence: [evidence({ id: "ev1", criterionIds: ["c1"], status: "passed" })],
      }),
      events: [event(1, "mission.completed", "Mission completed")],
      guardian: passingGuardian,
    };
    const snapshot = projectMissionForWeb(incoherentFixture);
    expect(snapshot.summary.state).toBe("completed_with_caveats");
    expect(snapshot.verification.state).toBe("failed");
    expect(() => WebMissionSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("falls back to a non-empty title when the objective is whitespace-only", () => {
    const blankTitleFixture: MissionWebProjectionInput = {
      workspaceId: WORKSPACE_ID,
      mission: mission({ objective: "   \n  ", criteria: [] }),
      events: [],
    };
    const snapshot = projectMissionForWeb(blankTitleFixture);
    expect(snapshot.summary.title.length).toBeGreaterThan(0);
    expect(snapshot.summary.title).toBe("Mission mission-1");
    expect(() => WebMissionSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("never serializes a progressPercent or numeric percent field", () => {
    for (const fixture of [runningFixture, blockedFixture, completedFixture]) {
      const serialized = JSON.stringify(projectMissionForWeb(fixture));
      expect(serialized).not.toContain("progressPercent");
      expect(serialized.toLowerCase()).not.toContain("percent");
    }
  });
});

describe("projectMissionSummaryForWeb", () => {
  it("produces a schema-valid summary matching the snapshot summary", () => {
    const summary = projectMissionSummaryForWeb(runningFixture);
    expect(() => WebMissionSummarySchema.parse(summary)).not.toThrow();
    expect(summary).toEqual(projectMissionForWeb(runningFixture).summary);
    expect(summary.projectId).toBe(PROJECT_ID);
    expect(summary.workspaceId).toBe(WORKSPACE_ID);
  });
});
