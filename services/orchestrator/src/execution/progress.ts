import { createHash } from "node:crypto";
import type {
  MissionProgressKind,
  MissionProgressObservation,
} from "@morrow/contracts";

export interface MissionProgressSnapshot {
  missionId: string;
  operationId: string | null;
  strategyFingerprint: string | null;
  artifactFingerprints: string[];
  toolResultFingerprints: string[];
  evidenceIds: string[];
  uncertainty: number;
  openHypotheses: string[];
  checkpointIds: string[];
  validatedCriterionIds: string[];
  observedAt: string;
}

export interface ExhaustionAssessment {
  exhausted: boolean;
  next: "continue" | "focused_diagnosis" | "change_strategy" | "retry_with_changed_conditions" | "block_precisely";
  reason: string;
  untriedStrategyFingerprints: string[];
}

export interface ExhaustionOptions {
  diagnosisCompleted?: boolean;
  availableStrategyFingerprints?: string[];
  /**
   * Turns observed without meaningful progress since the last observation.
   * Callers that omit it keep the pre-stagnation behavior, where only the most
   * recent observation decides. Supplying it is what lets a caller express
   * "real progress happened, and then work stalled" — a state the observation
   * history alone cannot represent, because a stalled turn records nothing.
   */
  stagnantTurns?: number;
  stagnationThreshold?: number;
  /** External conditions that could change and make a retry worthwhile. */
  retriableConditions?: string[];
  /** The precise external dependency blocking progress, when one is known. */
  blocker?: string | null;
}

const DEFAULT_STAGNATION_THRESHOLD = 3;

const MEANINGFUL_PROGRESS = new Set<MissionProgressKind>([
  "artifact_changed",
  "evidence_gained",
  "uncertainty_reduced",
  "hypothesis_eliminated",
  "strategy_changed",
  "checkpoint_created",
  "criterion_validated",
]);

/** True when an observation represents a measurable change, not just activity. */
export function isMeaningfulProgress(kind: MissionProgressKind): boolean {
  return MEANINGFUL_PROGRESS.has(kind);
}

function additions(previous: string[], current: string[]): string[] {
  const old = new Set(previous);
  return current.filter((value) => !old.has(value));
}

function removals(previous: string[], current: string[]): string[] {
  const next = new Set(current);
  return previous.filter((value) => !next.has(value));
}

function observation(
  current: MissionProgressSnapshot,
  kind: MissionProgressKind,
  summary: string,
  evidenceIds: string[] = [],
): MissionProgressObservation {
  const identity = createHash("sha256")
    .update(`${current.missionId}\n${current.operationId ?? ""}\n${kind}\n${summary}\n${current.observedAt}`)
    .digest("hex")
    .slice(0, 24);
  return {
    version: 1,
    id: `progress-${identity}`,
    missionId: current.missionId,
    operationId: current.operationId,
    kind,
    summary,
    evidenceIds,
    strategyFingerprint: current.strategyFingerprint,
    createdAt: current.observedAt,
  };
}

export function assessProgress(
  previous: MissionProgressSnapshot,
  current: MissionProgressSnapshot,
): MissionProgressObservation[] {
  if (previous.missionId !== current.missionId) throw new Error("Progress snapshots must belong to the same mission");
  const result: MissionProgressObservation[] = [];
  const artifacts = additions(previous.artifactFingerprints, current.artifactFingerprints);
  const toolResults = additions(previous.toolResultFingerprints, current.toolResultFingerprints);
  const evidence = additions(previous.evidenceIds, current.evidenceIds);
  const eliminated = removals(previous.openHypotheses, current.openHypotheses);
  const checkpoints = additions(previous.checkpointIds, current.checkpointIds);
  const criteria = additions(previous.validatedCriterionIds, current.validatedCriterionIds);

  if (artifacts.length > 0) result.push(observation(current, "artifact_changed", `${artifacts.length} artifact fingerprint(s) changed.`));
  if (toolResults.length > 0) result.push(observation(current, "tool_result_observed", `${toolResults.length} new tool result(s) observed.`));
  if (evidence.length > 0) result.push(observation(current, "evidence_gained", `${evidence.length} evidence item(s) gained.`, evidence));
  if (current.uncertainty < previous.uncertainty) result.push(observation(current, "uncertainty_reduced", `Uncertainty reduced from ${previous.uncertainty} to ${current.uncertainty}.`));
  if (eliminated.length > 0) result.push(observation(current, "hypothesis_eliminated", `Eliminated hypotheses: ${eliminated.join(", ")}.`));
  if (current.strategyFingerprint !== previous.strategyFingerprint) result.push(observation(current, "strategy_changed", `Strategy changed to ${current.strategyFingerprint ?? "none"}.`));
  if (checkpoints.length > 0) result.push(observation(current, "checkpoint_created", `${checkpoints.length} durable checkpoint(s) created.`));
  if (criteria.length > 0) result.push(observation(current, "criterion_validated", `Validated criteria: ${criteria.join(", ")}.`));
  return result;
}

export function assessExhaustion(
  history: MissionProgressObservation[],
  options: ExhaustionOptions = {},
): ExhaustionAssessment {
  const available = options.availableStrategyFingerprints ?? [];
  const threshold = options.stagnationThreshold ?? DEFAULT_STAGNATION_THRESHOLD;
  const stagnantTurns = options.stagnantTurns ?? 0;
  const stagnant = stagnantTurns >= threshold;
  const latest = history.at(-1);

  // A meaningful last observation only justifies continuing while the caller
  // has not yet watched the work stall for a full threshold of turns. Without
  // this the assessment could never escalate after any real progress.
  if (!stagnant && (!latest || MEANINGFUL_PROGRESS.has(latest.kind))) {
    return {
      exhausted: false,
      next: "continue",
      reason: latest ? `Latest observation ${latest.kind} is measurable progress.` : "No failed strategy history exists.",
      untriedStrategyFingerprints: available,
    };
  }
  const stalled = stagnant
    ? `Work stalled for ${stagnantTurns} turn(s) without measurable progress.`
    : "Repeated work produced no measurable progress.";
  if (!options.diagnosisCompleted) {
    return {
      exhausted: false,
      next: "focused_diagnosis",
      reason: `${stalled} A focused diagnosis has not run yet.`,
      untriedStrategyFingerprints: available,
    };
  }
  const tried = new Set(history.map((item) => item.strategyFingerprint).filter((item): item is string => item !== null));
  const untried = available.filter((strategy) => !tried.has(strategy));
  if (untried.length > 0) {
    return {
      exhausted: false,
      next: "change_strategy",
      reason: `${stalled} A distinct safe strategy remains untried.`,
      untriedStrategyFingerprints: untried,
    };
  }
  const retriable = options.retriableConditions ?? [];
  if (retriable.length > 0) {
    return {
      exhausted: false,
      next: "retry_with_changed_conditions",
      reason: `${stalled} Every strategy was tried, but these conditions can still change: ${retriable.join("; ")}.`,
      untriedStrategyFingerprints: [],
    };
  }
  return {
    exhausted: true,
    next: "block_precisely",
    reason: options.blocker
      ? `${stalled} Focused diagnosis completed and every supplied safe strategy was tried. Blocked by: ${options.blocker}.`
      : `${stalled} Focused diagnosis completed and every supplied safe strategy was tried without measurable progress.`,
    untriedStrategyFingerprints: [],
  };
}
