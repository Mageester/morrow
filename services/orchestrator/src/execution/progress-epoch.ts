import { stableStringify } from "./loop-detector.js";

/** Maximum executions of one exact observation call during one unchanged epoch. */
export const MAX_OBSERVATION_SIGNATURE_EXECUTIONS = 3;

/** Provider-turn boundary at which a delivery task receives action-only recovery. */
export const ARTIFACT_DELIVERY_RECOVERY_TURN = 6;

/** Provider-turn boundary at which an unchanged delivery task must stop or replan. */
export const ARTIFACT_DELIVERY_STOP_TURN = 12;

export interface ProgressEpochOptions {
  maxObservationExecutions?: number;
}

export interface ObservationRecord {
  signature: string;
  executionsPerSignature: number;
  exceeded: boolean;
  epoch: number;
}

export interface ProgressEpochSnapshot {
  epoch: number;
  meaningfulDeliveryProgress: boolean;
  observationCounts: Record<string, number>;
}

export interface ProgressEpoch {
  /** Record an observation without allowing it to reset the current epoch. */
  recordObservation(toolName: string, args: unknown): ObservationRecord;
  /** Persisted observation evidence is intentionally non-progress activity. */
  recordObservationEvidence(evidenceId: string): void;
  /** Context compaction is an internal boundary, not delivery progress. */
  recordCompaction(): void;
  /** A durable artifact mutation starts a new progress epoch. */
  recordMutation(fingerprint: string): void;
  /** A new named verification failure with new diagnostics starts an epoch. */
  recordVerificationFailure(diagnosticFingerprint: string): boolean;
  count(toolName: string, args: unknown): number;
  currentEpoch(): number;
  hasMeaningfulDeliveryProgress(): boolean;
  snapshot(): ProgressEpochSnapshot;
}

/**
 * Normalize a tool observation into a stable, exact signature. JSON key order
 * does not change identity, while tool name and every argument value do.
 */
export function observationSignature(toolName: string, args: unknown): string {
  let normalized = args;
  if (typeof args === "string") {
    try {
      normalized = JSON.parse(args);
    } catch {
      // Keep malformed/non-JSON arguments exact; the call still needs a bound.
    }
  }
  return `${toolName}:${stableStringify(normalized)}`;
}

export function createProgressEpoch(options: ProgressEpochOptions = {}): ProgressEpoch {
  const maxExecutions = Math.max(1, options.maxObservationExecutions ?? MAX_OBSERVATION_SIGNATURE_EXECUTIONS);
  let epoch = 0;
  let meaningfulDeliveryProgress = false;
  let counts = new Map<string, number>();
  let lastVerificationFailure: string | null = null;

  const startNewEpoch = (markMeaningful: boolean) => {
    epoch += 1;
    counts = new Map<string, number>();
    lastVerificationFailure = null;
    if (markMeaningful) meaningfulDeliveryProgress = true;
  };

  return {
    recordObservation(toolName, args) {
      const signature = observationSignature(toolName, args);
      const executionsPerSignature = (counts.get(signature) ?? 0) + 1;
      counts.set(signature, executionsPerSignature);
      return {
        signature,
        executionsPerSignature,
        exceeded: executionsPerSignature > maxExecutions,
        epoch,
      };
    },
    recordObservationEvidence(_evidenceId) {
      // Evidence emitted by an observation is audit data, not delivery.
    },
    recordCompaction() {
      // Compaction preserves the same task progress epoch.
    },
    recordMutation(_fingerprint) {
      startNewEpoch(true);
    },
    recordVerificationFailure(diagnosticFingerprint) {
      if (diagnosticFingerprint === lastVerificationFailure) return false;
      startNewEpoch(false);
      lastVerificationFailure = diagnosticFingerprint;
      return true;
    },
    count(toolName, args) {
      return counts.get(observationSignature(toolName, args)) ?? 0;
    },
    currentEpoch() {
      return epoch;
    },
    hasMeaningfulDeliveryProgress() {
      return meaningfulDeliveryProgress;
    },
    snapshot() {
      return {
        epoch,
        meaningfulDeliveryProgress,
        observationCounts: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      };
    },
  };
}

export interface ArtifactDeliveryAssessmentInput {
  requiresArtifact: boolean;
  providerTurn: number;
  mutationObserved: boolean;
}

export interface ArtifactDeliveryAssessment {
  actionOnlyRecoveryRequired: boolean;
  strategyTerminationRequired: boolean;
}

/**
 * Bound pre-mutation wandering only for requests whose shape requires a
 * workspace artifact. Read-only tasks never enter either recovery boundary.
 */
export function assessArtifactDelivery(input: ArtifactDeliveryAssessmentInput): ArtifactDeliveryAssessment {
  if (!input.requiresArtifact || input.mutationObserved) {
    return { actionOnlyRecoveryRequired: false, strategyTerminationRequired: false };
  }
  return {
    actionOnlyRecoveryRequired: input.providerTurn >= ARTIFACT_DELIVERY_RECOVERY_TURN
      && input.providerTurn < ARTIFACT_DELIVERY_STOP_TURN,
    strategyTerminationRequired: input.providerTurn >= ARTIFACT_DELIVERY_STOP_TURN,
  };
}
