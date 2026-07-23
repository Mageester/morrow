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
  /** The most recent failed worker dispatch, when one exists. */
  dispatchFailure?: { message: string; at: string } | null;
  /** Whether at least one model provider is currently configured. */
  providersConfigured?: boolean;
  /**
   * The concrete model/provider the mission's most recent worker task actually
   * routed to. Missions rarely pin `execution.model`; the router resolves a
   * model per task from the preset, so this is what genuinely ran — the header
   * must name it rather than the abstract preset.
   */
  routedModel?: string | null;
  routedProviderId?: string | null;
}

/** Attention id for the mission-level plan approval (not an approvals row). */
export function planApprovalAttentionId(missionId: string): string {
  return `${missionId}:plan-approval`;
}

/** Attention id for the "worker could not start" recovery surface. */
export function dispatchBlockerAttentionId(missionId: string): string {
  return `${missionId}:dispatch-blocker`;
}

// ── Status + runtime → ONE UI state and ONE phase ───────────────────────────
// This is the ONLY conversion from persisted mission state to what the user
// sees. The mission aggregate and the runtime machine are reconciled HERE, in
// one place, so the projected state and the projected phase can never
// contradict each other (the old code derived them independently, which is
// how a mission once showed "Draft" beside "Doing the work").
//
// Precedence:
//   1. A terminal mission status is final — the runtime cannot override it.
//   2. A blocked runtime (worker could not start / strategies exhausted) wins
//      over any non-terminal status: the user must act.
//   3. Approval waits surface as needs_input.
//   4. Otherwise the runtime describes live work; a mission whose runtime is
//      actively working is presented as working even while the aggregate is
//      still formally in draft.
//
// `verified` guards the completed headline against inconsistent Guardian
// input, exactly as before.
interface DerivedPresentation {
  state: WebMissionUiState;
  phase: string;
}

function derivePresentation(
  mission: Mission,
  runtime: MissionRuntime | null | undefined,
  verified: boolean,
): DerivedPresentation {
  switch (mission.status) {
    case "completed":
      return verified
        ? { state: "completed_verified", phase: "Finished" }
        : { state: "completed_with_caveats", phase: "Finished with caveats" };
    case "completed_with_reservations":
      return { state: "completed_with_caveats", phase: "Finished with caveats" };
    case "partially_completed":
      return { state: "completed_with_caveats", phase: "Partly finished" };
    case "failed":
      return { state: "failed", phase: "Ran into a problem" };
    case "cancelled":
      return { state: "cancelled", phase: "Cancelled" };
    case "blocked":
      return { state: "blocked", phase: "Paused — needs your attention" };
    default:
      break;
  }

  // The plan approval wait is mission-level state and reads the same whether
  // or not the runtime machine has parked yet.
  if (mission.status === "awaiting_criteria_approval" && runtime?.state !== "blocked") {
    return { state: "needs_input", phase: "Waiting for you to approve the plan" };
  }

  // Non-terminal mission: the runtime machine describes what is really
  // happening right now.
  if (runtime) {
    switch (runtime.state) {
      case "blocked":
        return { state: "blocked", phase: "Paused — needs your attention" };
      case "waiting_for_approval":
        return { state: "needs_input", phase: "Waiting for your approval" };
      case "cancelled":
      case "abandoned":
        return { state: "cancelled", phase: "Stopped" };
      case "superseded":
        return { state: "superseded", phase: "Replaced by a newer run" };
      case "created":
        return { state: mission.status === "draft" ? "draft" : "working", phase: "Preparing the mission" };
      case "orienting":
        return { state: "working", phase: "Understanding the request" };
      case "planning":
        return { state: "working", phase: "Planning the work" };
      case "executing":
        return { state: "working", phase: "Doing the work" };
      case "validating":
        return { state: mission.status === "reviewing" ? "reviewing" : "working", phase: "Checking the results" };
      case "waiting_for_tool":
        return { state: "working", phase: "Waiting on a tool" };
      case "recovering":
        return { state: "working", phase: "Recovering from a problem" };
      case "replanning":
        return { state: "working", phase: "Adjusting the plan" };
      case "completed":
        // Runtime finished but the aggregate has not been graded terminal yet:
        // present the review-in-flight truthfully rather than claiming success.
        return { state: "reviewing", phase: "Finalizing the result" };
      default:
        break;
    }
  }

  // No runtime row (legacy missions) — fall back to the mission status alone.
  switch (mission.status) {
    case "awaiting_criteria_approval":
      return { state: "needs_input", phase: "Waiting for you to approve the plan" };
    case "running":
      return { state: "working", phase: "Doing the work" };
    case "reviewing":
      return { state: "reviewing", phase: "Reviewing the results" };
    default:
      return { state: "draft", phase: "Preparing the mission" };
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

// The activity stream is a "recent progress" view, not a full audit log (the
// complete history stays durable in the event store). A long-running mission
// that recovers many times can emit hundreds of events; rendering every one
// produces an unusable multi-screen wall, so the stream is bounded to its most
// recent window. Normal missions (well under this many events) are unaffected.
const ACTIVITY_WINDOW = 80;

function buildActivity(missionId: string, events: readonly MissionEvent[]): WebMissionActivity[] {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const recent = ordered.length > ACTIVITY_WINDOW ? ordered.slice(-ACTIVITY_WINDOW) : ordered;
  return recent
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

function buildAttention(input: MissionWebProjectionInput): WebAttentionRequest[] {
  const { mission, guardian, runtime } = input;
  const pendingApprovals = input.pendingApprovals ?? [];
  const attention: WebAttentionRequest[] = [];

  // The worker could not start (typically: no configured model provider).
  // This is the mission's single most important surface while it lasts, and
  // it is fully actionable: connect a provider (when that is the cause), then
  // retry. The raw technical message rides along for the details disclosure.
  if (runtime?.state === "blocked" && input.dispatchFailure) {
    const providersConfigured = input.providersConfigured ?? true;
    attention.push({
      id: dispatchBlockerAttentionId(mission.id),
      missionId: mission.id,
      kind: providersConfigured ? "blocker" : "connection",
      title: providersConfigured
        ? "Morrow couldn't start this mission"
        : "Connect an AI model to continue",
      explanation: clamp(
        providersConfigured
          ? `The work could not be started. Your mission and everything entered so far are saved. Technical reason: ${input.dispatchFailure.message}`
          : `Morrow needs an AI model before it can work on this mission. Your mission is saved — nothing is lost. Open Connections, add a model provider, then retry. Technical reason: ${input.dispatchFailure.message}`,
        2000,
      ),
      recommendation: providersConfigured
        ? "Retry the mission. If it fails again, check the provider's status on the Connections page."
        : "Add a provider on the Connections page (an API key or a local Ollama server), then retry the mission.",
      choices: [
        { id: "retry", label: "Try again", description: "Restart the mission from its saved state.", recommended: true, destructive: false },
      ],
      canContinueElsewhere: false,
      createdAt: input.dispatchFailure.at,
    });
  } else if (mission.status === "blocked" || runtime?.state === "blocked") {
    // Any other blocked mission still leads with a blocker so the UI
    // foregrounds it.
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
      choices: runtime?.state === "blocked"
        ? [{ id: "retry", label: "Try again", description: "Restart the mission from its saved state.", recommended: true, destructive: false }]
        : [],
      canContinueElsewhere: false,
      createdAt: mission.updatedAt,
    });
  }

  // The plan approval gate: proposed success criteria await a human decision.
  if (mission.status === "awaiting_criteria_approval") {
    const proposed = mission.criteria.filter((criterion) => criterion.state === "proposed" || criterion.state === "approved");
    const preview = proposed.slice(0, 3).map((criterion) => criterion.description).join(" · ");
    attention.push({
      id: planApprovalAttentionId(mission.id),
      missionId: mission.id,
      kind: "approval",
      title: "Review and approve the plan",
      explanation: clamp(
        proposed.length > 0
          ? `Morrow proposes ${proposed.length} success requirement${proposed.length === 1 ? "" : "s"} for this mission: ${preview}`
          : "Morrow prepared a plan for this mission and is waiting for your approval before starting.",
        2000,
      ),
      recommendation: "Approve to start the work, or decline to cancel the mission.",
      choices: [
        { id: "approve", label: "Approve and start", description: "Morrow begins working immediately.", recommended: true, destructive: false },
        { id: "deny", label: "Cancel mission", description: "Stops this mission. Your objective stays saved in the timeline.", recommended: false, destructive: true },
      ],
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
    // Guardian operation entries are engineering audit strings ("Operation
    // ended failed."). When the mission has not started real work yet they
    // explain nothing on their own; the attention surface carries the real,
    // actionable cause, so only criterion/task-level guardian details remain
    // here as caveats.
    for (const item of guardian?.failed ?? []) {
      if (item.kind === "operation") continue;
      caveats.push(clamp(item.detail, 1000));
    }
    for (const item of guardian?.blocked ?? []) {
      if (item.kind === "operation") continue;
      caveats.push(clamp(item.detail, 1000));
    }
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

const ACTIVE_RUNTIME_STATES: ReadonlySet<MissionRuntime["state"]> = new Set([
  "orienting", "planning", "executing", "validating", "waiting_for_tool", "recovering", "replanning",
]);

function buildCurrentWork(
  mission: Mission,
  runtime: MissionRuntime | null | undefined,
  criteria: readonly MissionCriterion[],
  events: readonly MissionEvent[],
): string | null {
  const active = criteria.find((criterion) => criterion.state === "in_progress");
  if (active) return clamp(active.description, 2000);
  const working = mission.status === "running"
    || (runtime !== null && runtime !== undefined && ACTIVE_RUNTIME_STATES.has(runtime.state));
  if (working && events.length > 0) {
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
  const attention = buildAttention(input);

  const sortedEvents = [...events].sort((a, b) => a.sequence - b.sequence);
  const latestEvent = sortedEvents.at(-1);
  const latestActivity = latestEvent
    ? clamp(
        humanizeEventSummary(latestEvent) ??
          (latestEvent.summary.trim().length > 0 ? latestEvent.summary.trim() : humanizeEventType(latestEvent.type)),
        1000,
      )
    : null;

  const presentation = derivePresentation(mission, input.runtime, verified);
  // Name the model that actually ran: a pinned execution model wins, then the
  // model the router resolved for the latest worker task, then a bare provider,
  // and only as a last resort the abstract preset (before any task routed).
  const execution = mission.execution;
  const modelLabel = execution.model
    ?? input.routedModel
    ?? execution.providerId
    ?? input.routedProviderId
    ?? `${execution.preset} preset`;

  return {
    version: 1,
    id: mission.id,
    projectId: mission.projectId,
    workspaceId: input.workspaceId,
    conversationId: mission.conversationId,
    title: clamp(input.title ?? deriveTitle(mission.objective, mission.id), 160),
    objective: mission.objective,
    state: presentation.state,
    currentPhase: clamp(presentation.phase, 160),
    modelLabel: clamp(modelLabel, 160),
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
    currentWork: buildCurrentWork(mission, input.runtime, criteria, events),
    recentActivity: buildActivity(mission.id, events),
    attention: buildAttention(input),
    artifacts: buildArtifacts(mission, evidence, result),
    verification: buildVerification(mission, criteria, evidence, input.guardian, result),
  };
}
