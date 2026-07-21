import type {
  Approval,
  Mission,
  MissionCriterion,
  MissionCriterionState,
  MissionEvent,
  MissionEventType,
  MissionEvidence,
  MissionResult,
  MissionRuntime,
  WebAttentionRequest,
  WebMissionActivity,
  WebMissionArtifact,
  WebMissionMilestone,
  WebMissionSnapshot,
  WebMissionSummary,
  WebMissionUiState,
} from "@morrow/contracts";
import type { GuardianDecision } from "../mission/guardian.js";

// `WebVerificationSummary` is not re-exported as a type by the contracts
// package (only its schema is), so derive it structurally from the snapshot.
type WebVerificationSummary = WebMissionSnapshot["verification"];

/**
 * Everything a route needs to gather so the pure projection can run. The
 * projection performs NO I/O — callers assemble plain records (already loaded
 * from repositories) and hand them in. This keeps the module trivially testable
 * and free of any database coupling.
 */
export interface MissionWebProjectionInput {
  /** The persisted mission aggregate. */
  mission: Mission;
  /** The workspace the mission belongs to (routes resolve this from the project). */
  workspaceId: string;
  /** Optional human-authored title; when absent a title is derived from the objective. */
  title?: string;
  /** Persisted mission timeline, used verbatim in sequence order. */
  events?: readonly MissionEvent[];
  /** Criteria override; defaults to `mission.criteria`. */
  criteria?: readonly MissionCriterion[];
  /** Evidence override; defaults to `mission.evidence`. */
  evidence?: readonly MissionEvidence[];
  /** The latest Guardian assessment, if one has been computed. */
  guardian?: GuardianDecision | null;
  /** Approvals still awaiting a human decision. */
  pendingApprovals?: readonly Approval[];
  /** Durable runtime state, used to describe the current phase. */
  runtime?: MissionRuntime | null;
}

// ── Status → UI state ────────────────────────────────────────────────────────
// This switch is the ONLY conversion from a raw mission status to a UI state.
// It is exhaustive over `MissionStatus`; there is no numeric progress anywhere.
//
// `verified` guards the completed headline against inconsistent Guardian input:
// a completed mission only reads as "completed_verified" when Guardian passed
// AND no non-waived criterion remains failed, so the summary headline can never
// contradict a "failed" verification state.
function uiState(status: Mission["status"], verified: boolean): WebMissionUiState {
  switch (status) {
    case "draft":
      return "draft";
    case "awaiting_criteria_approval":
      return "needs_input";
    case "running":
      return "working";
    case "reviewing":
      return "reviewing";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "completed":
      return verified ? "completed_verified" : "completed_with_caveats";
    case "completed_with_reservations":
    case "partially_completed":
      return "completed_with_caveats";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

// ── Criterion state → milestone state ────────────────────────────────────────
// Honest structural mapping; a criterion is only "completed" once verified.
const MILESTONE_STATE: Record<MissionCriterionState, WebMissionMilestone["state"]> = {
  proposed: "pending",
  approved: "pending",
  in_progress: "running",
  verified: "completed",
  failed: "failed",
  waived: "skipped",
  unverified: "pending",
};

function milestoneState(state: MissionCriterionState): WebMissionMilestone["state"] {
  return MILESTONE_STATE[state];
}

// ── Activity kind mapping ────────────────────────────────────────────────────
const ACTIVITY_KIND: Record<MissionEventType, WebMissionActivity["kind"]> = {
  "mission.created": "system",
  "mission.criteria_generated": "progress",
  "mission.criteria_approved": "approval",
  "mission.started": "progress",
  "mission.checkpoint_created": "system",
  "mission.evidence_recorded": "verification",
  "mission.criterion_verified": "verification",
  "mission.criterion_failed": "verification",
  "mission.failure_recorded": "recovery",
  "mission.loop_detected": "recovery",
  "mission.recovery_applied": "recovery",
  "mission.rolled_back": "recovery",
  "mission.review_started": "verification",
  "mission.review_completed": "verification",
  "mission.status_changed": "system",
  "mission.completed": "progress",
  "mission.cancelled": "system",
  "mission.plan_revised": "decision",
  "mission.learnings_extracted": "system",
  "mission.impact_analyzed": "system",
  "mission.specialists_planned": "decision",
  "mission.cortex_ready": "system",
  "mission.contract_built": "decision",
  "mission.requirement_reopened": "recovery",
  "mission.requirement_status_changed": "progress",
};

function humanizeEventType(type: MissionEventType): string {
  return type.replace(/^mission\./, "").replace(/_/g, " ");
}

// ── Consumer-facing activity copy ────────────────────────────────────────────
// Stored event summaries are engineering audit strings ("Contract built from
// verbatim objective", "Status: draft → running"). The web surface presents a
// human reading of the same fact; when a summary is rewritten, the original
// audit string is preserved verbatim in the activity `detail` field so nothing
// is hidden from inspection.
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  awaiting_criteria_approval: "Waiting for plan approval",
  running: "Running",
  reviewing: "Reviewing",
  completed: "Completed",
  completed_with_reservations: "Completed with caveats",
  partially_completed: "Partly finished",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
};

function statusLabel(value: unknown): string | null {
  return typeof value === "string" ? (STATUS_LABEL[value] ?? null) : null;
}

function humanizeEventSummary(event: MissionEvent): string | null {
  switch (event.type) {
    case "mission.contract_built": {
      const nodes = event.data["nodes"];
      return typeof nodes === "number" && nodes > 0
        ? `Defined ${nodes} success requirement${nodes === 1 ? "" : "s"} from your objective`
        : "Defined success requirements from your objective";
    }
    case "mission.specialists_planned": {
      const roles = event.data["roles"];
      const count = Array.isArray(roles) ? roles.length : null;
      return count !== null && count > 0
        ? `Planned ${count} specialist role${count === 1 ? "" : "s"} for this mission`
        : "Planned specialist roles for this mission";
    }
    case "mission.status_changed": {
      const from = statusLabel(event.data["from"]);
      const to = statusLabel(event.data["to"]);
      return from && to ? `Status changed from ${from} to ${to}` : null;
    }
    case "mission.cortex_ready":
      return "Loaded saved project memory automatically";
    case "mission.started":
      return "Work started";
    default:
      return null;
  }
}

function deriveTitle(objective: string, missionId: string): string {
  const firstLine = objective.split("\n")[0]?.trim() ?? "";
  // A whitespace-only objective would yield an empty title and violate the
  // schema's `title.min(1)`; fall back to a mission-identified label instead.
  const base = firstLine.length > 0 ? firstLine : objective.trim();
  const safe = base.length > 0 ? base : `Mission ${missionId}`;
  if (safe.length <= 160) return safe;
  return `${safe.slice(0, 159).trimEnd()}…`;
}

// Phase labels never imply a percentage; they name what is happening now.
const RUNTIME_PHASE: Record<MissionRuntime["state"], string> = {
  created: "Getting started",
  orienting: "Understanding the request",
  planning: "Planning the work",
  executing: "Doing the work",
  validating: "Checking the results",
  waiting_for_tool: "Waiting on a tool",
  waiting_for_approval: "Waiting for your approval",
  recovering: "Recovering from a problem",
  replanning: "Adjusting the plan",
  blocked: "Blocked — needs your input",
  completed: "Finished",
  cancelled: "Cancelled",
  abandoned: "Stopped",
  superseded: "Replaced by a newer run",
};

const STATUS_PHASE: Record<Mission["status"], string> = {
  draft: "Drafting the mission",
  awaiting_criteria_approval: "Waiting for you to approve the plan",
  running: "Doing the work",
  reviewing: "Reviewing the results",
  completed: "Finished",
  completed_with_reservations: "Finished with caveats",
  partially_completed: "Partly finished",
  blocked: "Blocked — needs your input",
  failed: "Ran into a problem",
  cancelled: "Cancelled",
};

function currentPhase(mission: Mission, runtime: MissionRuntime | null | undefined): string {
  if (runtime) return RUNTIME_PHASE[runtime.state];
  return STATUS_PHASE[mission.status];
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function buildMilestones(criteria: readonly MissionCriterion[]): WebMissionMilestone[] {
  return [...criteria]
    .sort((a, b) => a.order - b.order)
    .map((criterion) => ({
      id: criterion.id,
      title: clamp(criterion.description, 1000),
      state: milestoneState(criterion.state),
      evidenceIds: [...criterion.evidenceIds],
    }));
}

function buildActivity(missionId: string, events: readonly MissionEvent[]): WebMissionActivity[] {
  return [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((event) => {
      const raw = event.summary.trim().length > 0 ? event.summary.trim() : humanizeEventType(event.type);
      const humanized = humanizeEventSummary(event);
      return {
        id: event.id,
        missionId,
        cursor: event.sequence,
        kind: ACTIVITY_KIND[event.type],
        summary: clamp(humanized ?? raw, 1000),
        detail: humanized !== null && humanized !== raw ? clamp(raw, 4000) : null,
        actor: { kind: "morrow" as const, name: "Morrow" },
        artifactIds: [],
        createdAt: event.createdAt,
      };
    });
}

// Artifacts are only surfaced from concrete evidence rows carrying an
// `artifactPath` and from the mission result's artifact references. Nothing is
// invented: no artifact appears without a persisted path behind it.
function buildArtifacts(
  mission: Mission,
  evidence: readonly MissionEvidence[],
  result: MissionResult | null,
): WebMissionArtifact[] {
  const artifacts: WebMissionArtifact[] = [];
  const seenPaths = new Set<string>();

  for (const row of evidence) {
    if (row.artifactPath === null || seenPaths.has(row.artifactPath)) continue;
    seenPaths.add(row.artifactPath);
    artifacts.push({
      id: row.id,
      missionId: mission.id,
      kind: "file",
      title: clamp(basename(row.artifactPath), 240),
      mimeType: null,
      preview: null,
      openPath: clamp(row.artifactPath, 1024),
      version: 1,
      createdAt: row.recordedAt,
    });
  }

  const resultArtifacts = result?.artifacts ?? [];
  resultArtifacts.forEach((path, index) => {
    if (seenPaths.has(path)) return;
    seenPaths.add(path);
    artifacts.push({
      id: `${mission.id}:result-artifact:${index}`,
      missionId: mission.id,
      kind: "file",
      title: clamp(basename(path), 240),
      mimeType: null,
      preview: null,
      openPath: clamp(path, 1024),
      version: 1,
      createdAt: mission.completedAt ?? mission.updatedAt,
    });
  });

  return artifacts;
}

function buildAttention(
  mission: Mission,
  guardian: GuardianDecision | null | undefined,
  pendingApprovals: readonly Approval[],
): WebAttentionRequest[] {
  const attention: WebAttentionRequest[] = [];

  // A blocked mission always leads with a blocker so the UI foregrounds it.
  if (mission.status === "blocked") {
    const blockedDetails = guardian?.blocked.map((item) => item.detail).filter((d) => d.length > 0) ?? [];
    const explanation = blockedDetails.length > 0
      ? blockedDetails.join(" ")
      : "This mission is blocked and needs your input before it can continue.";
    attention.push({
      id: `${mission.id}:blocker`,
      missionId: mission.id,
      kind: "blocker",
      title: "Mission is blocked",
      explanation: clamp(explanation, 2000),
      recommendation: null,
      choices: [],
      canContinueElsewhere: false,
      createdAt: mission.updatedAt,
    });
  }

  for (const approval of pendingApprovals) {
    if (approval.status !== "pending") continue;
    attention.push({
      id: approval.id,
      missionId: mission.id,
      kind: "approval",
      title: clamp(approval.summary, 240),
      explanation: clamp(approval.summary, 2000),
      recommendation: null,
      choices: [
        { id: "approve", label: "Approve", description: null, recommended: false, destructive: false },
        { id: "deny", label: "Deny", description: null, recommended: false, destructive: true },
      ],
      canContinueElsewhere: false,
      createdAt: approval.createdAt,
    });
  }

  return attention;
}

function buildVerification(
  mission: Mission,
  criteria: readonly MissionCriterion[],
  evidence: readonly MissionEvidence[],
  guardian: GuardianDecision | null | undefined,
  result: MissionResult | null,
): WebVerificationSummary {
  const hasFailedCriterion = criteria.some((criterion) => criterion.state === "failed");
  const guardianPassed = guardian?.passed ?? false;
  const passed = mission.status === "completed" && guardianPassed && !hasFailedCriterion;

  let state: WebVerificationSummary["state"];
  if (passed) {
    state = "passed";
  } else if (mission.status === "failed" || hasFailedCriterion) {
    state = "failed";
  } else if (
    mission.status === "completed"
    || mission.status === "completed_with_reservations"
    || mission.status === "partially_completed"
  ) {
    state = "passed_with_caveats";
  } else if (mission.status === "running" || mission.status === "reviewing") {
    state = "in_progress";
  } else {
    state = "not_ready";
  }

  const caveats: string[] = [];
  if (state !== "passed") {
    for (const risk of result?.unresolvedRisks ?? []) caveats.push(clamp(risk, 1000));
    for (const item of guardian?.failed ?? []) caveats.push(clamp(item.detail, 1000));
    for (const item of guardian?.blocked ?? []) caveats.push(clamp(item.detail, 1000));
  }

  const summary = result?.summary ?? "";
  const evidenceCount = evidence.filter((row) => row.status === "passed").length;

  return {
    state,
    summary: clamp(summary, 4000),
    evidenceCount,
    caveats,
  };
}

function buildCurrentWork(
  mission: Mission,
  criteria: readonly MissionCriterion[],
  events: readonly MissionEvent[],
): string | null {
  const active = criteria.find((criterion) => criterion.state === "in_progress");
  if (active) return clamp(active.description, 2000);
  if (mission.status === "running" && events.length > 0) {
    const last = [...events].sort((a, b) => a.sequence - b.sequence).at(-1);
    if (last && last.summary.trim().length > 0) return clamp(last.summary.trim(), 2000);
  }
  return null;
}

export function projectMissionSummaryForWeb(input: MissionWebProjectionInput): WebMissionSummary {
  const { mission } = input;
  const criteria = input.criteria ?? mission.criteria;
  const events = input.events ?? [];
  const guardianPassed = input.guardian?.passed ?? false;
  const hasFailedCriterion = criteria.some((criterion) => criterion.state === "failed");
  // A completed mission is only "verified" when Guardian passed AND no failed
  // criterion survives — otherwise the headline would contradict verification.
  const verified = guardianPassed && !hasFailedCriterion;

  const completedMilestones = criteria.filter((criterion) => milestoneState(criterion.state) === "completed").length;
  const attention = buildAttention(mission, input.guardian, input.pendingApprovals ?? []);

  const sortedEvents = [...events].sort((a, b) => a.sequence - b.sequence);
  const latestEvent = sortedEvents.at(-1);
  const latestActivity = latestEvent
    ? clamp(
        humanizeEventSummary(latestEvent) ??
          (latestEvent.summary.trim().length > 0 ? latestEvent.summary.trim() : humanizeEventType(latestEvent.type)),
        1000,
      )
    : null;

  return {
    version: 1,
    id: mission.id,
    projectId: mission.projectId,
    workspaceId: input.workspaceId,
    title: clamp(input.title ?? deriveTitle(mission.objective, mission.id), 160),
    objective: mission.objective,
    state: uiState(mission.status, verified),
    currentPhase: clamp(currentPhase(mission, input.runtime), 160),
    latestActivity,
    attentionCount: attention.length,
    completedMilestones,
    totalMilestones: criteria.length,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

export function projectMissionForWeb(input: MissionWebProjectionInput): WebMissionSnapshot {
  const { mission } = input;
  const criteria = input.criteria ?? mission.criteria;
  const evidence = input.evidence ?? mission.evidence;
  const events = input.events ?? [];
  const result = mission.result ?? null;

  return {
    version: 1,
    summary: projectMissionSummaryForWeb(input),
    milestones: buildMilestones(criteria),
    currentWork: buildCurrentWork(mission, criteria, events),
    recentActivity: buildActivity(mission.id, events),
    attention: buildAttention(mission, input.guardian, input.pendingApprovals ?? []),
    artifacts: buildArtifacts(mission, evidence, result),
    verification: buildVerification(mission, criteria, evidence, input.guardian, result),
  };
}
