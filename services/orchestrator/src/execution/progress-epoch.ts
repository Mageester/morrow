import { posix } from "node:path";
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

function normalizeObservationPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return ".";
  const normalized = posix.normalize(value.replace(/\\/g, "/"));
  return normalized.replace(/\/+$/, "") || ".";
}

function normalizedValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function normalizeRequiredString(
  parsed: Record<string, unknown>,
  key: string,
  normalize: (value: string) => string = (value) => value,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(parsed, key)) return { state: "missing" };
  const value = parsed[key];
  if (typeof value !== "string") return { state: "invalid", valueType: normalizedValueType(value) };
  return { state: "present", value: value.length === 0 ? "" : normalize(value) };
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), 1), maximum)
    : fallback;
}

function parsedArguments(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return { raw: args };
    }
  }
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

/**
 * Normalize an observation according to the executor's semantic defaults.
 * JSON key order does not change identity, omitted/default root paths do not
 * evade the guard, and optional bounded controls use the same effective value.
 */
export function normalizeObservationArguments(toolName: string, args: unknown): Record<string, unknown> {
  const parsed = parsedArguments(args);
  switch (toolName) {
    case "inspect_workspace":
    case "git_status":
    case "git_diff":
      return {};
    case "list_files":
      return { path: normalizeObservationPath(parsed.path) };
    case "read_file":
      return { path: normalizeRequiredString(parsed, "path", normalizeObservationPath) };
    case "search_text":
    case "search_files":
      return {
        query: normalizeRequiredString(parsed, "query"),
        path: normalizeObservationPath(parsed.path),
        caseSensitive: parsed.caseSensitive === true,
      };
    case "search_symbols":
      return {
        query: typeof parsed.query === "string" ? parsed.query : "",
        limit: boundedInteger(parsed.limit, 20, 50),
      };
    case "git_log":
      return { limit: boundedInteger(parsed.limit, 20, 20) };
    case "read_artifact":
      return {
        id: typeof parsed.id === "string" ? parsed.id : "",
        offset: typeof parsed.offset === "number" && Number.isFinite(parsed.offset) && parsed.offset >= 0 ? Math.floor(parsed.offset) : 0,
        length: boundedInteger(parsed.length, 16_384, 16_384),
      };
    case "find_skill":
      return { query: typeof parsed.query === "string" ? parsed.query : "" };
    case "load_skill":
      return { skill_id: typeof parsed.skill_id === "string" ? parsed.skill_id : "" };
    default:
      return parsed;
  }
}

/**
 * Normalize a tool observation into a stable, exact signature. Tool-specific
 * defaults are applied before stable serialization so syntactic variation
 * cannot evade the unchanged-epoch bound.
 */
export function observationSignature(toolName: string, args: unknown): string {
  return `${toolName}:${stableStringify(normalizeObservationArguments(toolName, args))}`;
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
