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
  next: "continue" | "focused_diagnosis" | "change_strategy" | "block_precisely";
  reason: string;
  untriedStrategyFingerprints: string[];
}

export interface ExhaustionOptions {
  diagnosisCompleted?: boolean;
  availableStrategyFingerprints?: string[];
}

const MEANINGFUL_PROGRESS = new Set<MissionProgressKind>([
  "artifact_changed",
  "evidence_gained",
  "uncertainty_reduced",
  "hypothesis_eliminated",
  "strategy_changed",
  "checkpoint_created",
  "criterion_validated",
]);

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
  const latest = history.at(-1);
  if (!latest || MEANINGFUL_PROGRESS.has(latest.kind)) {
    return {
      exhausted: false,
      next: "continue",
      reason: latest ? `Latest observation ${latest.kind} is measurable progress.` : "No failed strategy history exists.",
      untriedStrategyFingerprints: options.availableStrategyFingerprints ?? [],
    };
  }
  if (!options.diagnosisCompleted) {
    return {
      exhausted: false,
      next: "focused_diagnosis",
      reason: "Repeated work has not yet been followed by a focused diagnosis.",
      untriedStrategyFingerprints: options.availableStrategyFingerprints ?? [],
    };
  }
  const tried = new Set(history.map((item) => item.strategyFingerprint).filter((item): item is string => item !== null));
  const untried = (options.availableStrategyFingerprints ?? []).filter((strategy) => !tried.has(strategy));
  if (untried.length > 0) {
    return {
      exhausted: false,
      next: "change_strategy",
      reason: "A distinct safe strategy remains untried.",
      untriedStrategyFingerprints: untried,
    };
  }
  return {
    exhausted: true,
    next: "block_precisely",
    reason: "Focused diagnosis completed and every supplied safe strategy was tried without measurable progress.",
    untriedStrategyFingerprints: [],
  };
}
