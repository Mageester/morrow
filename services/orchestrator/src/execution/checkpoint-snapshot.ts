import { createHash } from "node:crypto";
import type { ExecutionCheckpointSnapshot } from "../repositories/execution-continuity.js";
import { redactSecrets, redactSecretsDeep } from "../provider/credentials.js";
import { sanitizeExecutionRequirement, sanitizeRequirementEvaluation, type ExecutionRequirement, type RequirementEvaluation } from "./requirements.js";

/** Hard upper bound for one serialized internal recovery checkpoint. */
export const MAX_EXECUTION_CHECKPOINT_BYTES = 131_072;

const MAX_ARRAY_ENTRIES = 256;

export interface CheckpointToolCallProjection {
  id?: string;
  toolName: string;
  status: string;
  argsJson?: string | null;
  resultJson?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
  cursor?: number;
}

export interface CheckpointRecoveryProjection {
  type: string;
  payload: unknown;
}

export interface CheckpointSnapshotProjectionInput {
  snapshot: ExecutionCheckpointSnapshot;
  completedCalls?: CheckpointToolCallProjection[];
  testCalls?: CheckpointToolCallProjection[];
  failedCalls?: CheckpointToolCallProjection[];
  recoveryAttempts?: CheckpointRecoveryProjection[];
}

function hash(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
  return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 24);
}

function boundedString(value: string, maxBytes = 8_192): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.max(0, Math.floor(maxBytes * 0.75));
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes - 32) end -= 16;
  return `${value.slice(0, end)}…[truncated:${hash(value)}]`;
}

function sanitizeActionableText(value: string, maxBytes = 480): string {
  const sanitized = redactSecrets(value).replace(/\s+/g, " ");
  return boundedString(sanitized, maxBytes);
}

function parseCallArguments(call: CheckpointToolCallProjection): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.argsJson ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizedActionTarget(call: CheckpointToolCallProjection): string {
  const args = parseCallArguments(call);
  if (call.toolName === "run_command") {
    const executable = typeof args.executable === "string" ? sanitizeActionableText(args.executable, 120) : "unknown";
    const rawArgs = Array.isArray(args.args) ? args.args.filter((value): value is string => typeof value === "string") : [];
    const commandArgs: string[] = [];
    let redactNext = false;
    for (const value of rawArgs) {
      if (redactNext) {
        commandArgs.push("[redacted]");
        redactNext = false;
        continue;
      }
      if (/^--?(?:token|api[-_]?key|password|secret|authorization|auth)$/i.test(value)) {
        commandArgs.push(value);
        redactNext = true;
        continue;
      }
      commandArgs.push(sanitizeActionableText(value, 180));
    }
    return `command=${boundedString([executable, ...commandArgs].join(" "), 720)}`;
  }
  if (typeof args.path === "string") return `target=${sanitizeActionableText(args.path, 240)}`;
  if (typeof args.query === "string") return `target=${sanitizeActionableText(args.query, 240)}`;
  if (typeof args.id === "string") return `target=${sanitizeActionableText(args.id, 160)}`;
  if (typeof args.processId === "string") return `target=${sanitizeActionableText(args.processId, 160)}`;
  return "target=unspecified";
}

function diagnosticSummary(call: CheckpointToolCallProjection): string {
  const details: string[] = [];
  if (call.errorType) details.push(`classification=${sanitizeActionableText(call.errorType, 120)}`);
  try {
    const result = JSON.parse(call.resultJson ?? "{}") as Record<string, unknown>;
    if (typeof result.exitCode === "number") details.push(`exit=${result.exitCode}`);
    for (const key of ["stderr", "error", "diagnostic", "stdout"]) {
      if (typeof result[key] === "string" && result[key].length > 0) {
        details.push(`diagnostic=${sanitizeActionableText(result[key] as string)}`);
        break;
      }
    }
  } catch {
    // Preserve the structured error classification below even when the raw
    // result is malformed.
  }
  if (call.errorMessage) details.push(`message=${sanitizeActionableText(call.errorMessage)}`);
  return details.join(" ") || "diagnostic=unclassified failure";
}

function resultSummary(resultJson: string | null | undefined): string {
  if (!resultJson) return "result=absent";
  try {
    const result = JSON.parse(resultJson) as Record<string, unknown>;
    if (typeof result.exitCode === "number") return `exit=${result.exitCode}`;
    if (typeof result.error === "string") return `error#${hash(result.error)}`;
    if (typeof result.status === "string") return `status#${hash(result.status)}`;
  } catch {
    return "result=non-json";
  }
  return "result=recorded";
}

/**
 * Project one completed call without copying its argument or result payload.
 * The hashes remain useful for deduplication and audit correlation while the
 * append-only tool-call row remains the authority for the full raw record.
 */
export function summarizeCheckpointCall(call: CheckpointToolCallProjection): string {
  return `${call.toolName}:${call.status}:call#${hash(call.id ?? `${call.toolName}:${call.argsJson ?? ""}`)}:args#${hash(call.argsJson ?? "")}:result#${hash(call.resultJson ?? "")}:${resultSummary(call.resultJson)}`;
}

/** Keep the recent failure actionable after raw history is compacted away. */
export function summarizeCheckpointFailure(call: CheckpointToolCallProjection): string {
  return `failure tool=${sanitizeActionableText(call.toolName, 120)} ${normalizedActionTarget(call)} ${diagnosticSummary(call)} cursor=${typeof call.cursor === "number" ? call.cursor : "unknown"}`;
}

export function summarizeCheckpointTest(call: CheckpointToolCallProjection): { command: string; exitCode: number | null; result: string } {
  let exitCode: number | null = null;
  try {
    const result = JSON.parse(call.resultJson ?? "{}") as { exitCode?: unknown };
    exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
  } catch {
    // The raw result remains in the append-only tool-call record.
  }
  return {
    command: `${call.toolName} ${normalizedActionTarget(call)}`,
    exitCode,
    result: `${resultSummary(call.resultJson)} ${diagnosticSummary(call)}`,
  };
}

export function summarizeCheckpointRecovery(attempt: CheckpointRecoveryProjection): string {
  return `${attempt.type}:payload#${hash(attempt.payload)}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].map((value) => boundedString(redactSecrets(value))).slice(-MAX_ARRAY_ENTRIES);
}

function boundedArtifactFingerprints(values: unknown): Array<{ path: string; contentHash: string }> {
  if (!Array.isArray(values)) return [];
  return values
    .flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const entry = value as Record<string, unknown>;
      if (typeof entry.path !== "string" || typeof entry.contentHash !== "string") return [];
      return [{
        path: boundedString(redactSecrets(entry.path), 1_024),
        contentHash: boundedString(redactSecrets(entry.contentHash), 160),
      }];
    })
    .slice(-MAX_ARRAY_ENTRIES);
}

function boundedBaselinePaths(values: string[], maxBytes = 24 * 1024): { paths: string[]; complete: boolean; count: number; identityHash: string } {
  const unique = [...new Set(values)].map((value) => boundedString(redactSecrets(value)));
  const paths: string[] = [];
  let bytes = 2;
  for (const path of unique) {
    const nextBytes = Buffer.byteLength(path, "utf8") + (paths.length > 0 ? 3 : 1);
    if (bytes + nextBytes > maxBytes) break;
    paths.push(path);
    bytes += nextBytes;
  }
  return {
    paths,
    complete: paths.length === unique.length,
    count: unique.length,
    identityHash: hash(unique),
  };
}

function boundStructured(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED]";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ENTRIES).map((item) => boundStructured(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, MAX_ARRAY_ENTRIES).map(([key, item]) => [key, boundStructured(item, depth + 1)]));
  }
  return value;
}

function redactStructured(value: unknown): unknown {
  return boundStructured(redactSecretsDeep(value));
}

function compactRecord(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const sanitized = redactStructured(value) as Record<string, unknown>;
  const serialized = JSON.stringify(sanitized) ?? "{}";
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return sanitized;
  return { summaryHash: hash(serialized), summary: "large structured checkpoint field omitted" };
}

function compactExecutionRequirement(requirement: ExecutionRequirement): ExecutionRequirement {
  const sanitized = sanitizeExecutionRequirement(requirement);
  return {
    id: boundedString(sanitized.id, 128),
    kind: sanitized.kind,
    sourceExcerpt: boundedString(sanitized.sourceExcerpt, 128),
    parameters: compactRecord(sanitized.parameters, 256),
    authoritative: sanitized.authoritative,
    status: sanitized.status,
    ...(sanitized.waiver
      ? {
          waiver: {
            authorizedBy: sanitized.waiver.authorizedBy,
            reason: boundedString(sanitized.waiver.reason, 160),
            evidenceRefs: uniqueStrings(sanitized.waiver.evidenceRefs).slice(-16),
          },
        }
      : {}),
  };
}

function compactRequirementEvaluation(evaluation: RequirementEvaluation): RequirementEvaluation {
  const sanitized = sanitizeRequirementEvaluation(evaluation);
  return {
    requirementId: boundedString(sanitized.requirementId, 128),
    kind: sanitized.kind,
    status: sanitized.status,
    evidence: uniqueStrings(sanitized.evidence).slice(-4),
    ...(sanitized.observedFileType ? { observedFileType: sanitized.observedFileType } : {}),
  };
}

function normalizeSnapshot(snapshot: ExecutionCheckpointSnapshot): ExecutionCheckpointSnapshot {
  const baseline = snapshot.requirementBaselinePaths ? boundedBaselinePaths(snapshot.requirementBaselinePaths) : undefined;
  return {
    ...snapshot,
    originalMission: boundedString(redactSecrets(snapshot.originalMission)),
    hardRequirements: uniqueStrings(snapshot.hardRequirements),
    prohibitedActions: uniqueStrings(snapshot.prohibitedActions),
    acceptanceCriteria: uniqueStrings(snapshot.acceptanceCriteria),
    decisions: uniqueStrings(snapshot.decisions),
    completedWork: uniqueStrings(snapshot.completedWork),
    currentPhase: boundedString(redactSecrets(snapshot.currentPhase)),
    filesChanged: uniqueStrings(snapshot.filesChanged),
    gitStatus: boundedString(redactSecrets(snapshot.gitStatus)),
    tests: snapshot.tests.slice(-MAX_ARRAY_ENTRIES).map((test) => ({
      command: sanitizeActionableText(test.command, 4_096),
      exitCode: test.exitCode,
      result: sanitizeActionableText(test.result, 4_096),
    })),
    unresolvedFailures: uniqueStrings(snapshot.unresolvedFailures),
    recoveryAttempts: uniqueStrings(snapshot.recoveryAttempts),
    pendingWork: uniqueStrings(snapshot.pendingWork),
    approvals: compactRecord(snapshot.approvals, 8_192),
    providerRouting: compactRecord(snapshot.providerRouting, 8_192),
    providerContinuationRefs: uniqueStrings(snapshot.providerContinuationRefs),
    evidenceRequired: uniqueStrings(snapshot.evidenceRequired),
    ...(baseline
      ? {
          requirementBaselinePaths: baseline.paths,
          requirementBaselinePathCount: snapshot.requirementBaselinePathCount ?? baseline.count,
          requirementBaselineIdentityHash: snapshot.requirementBaselineIdentityHash ?? baseline.identityHash,
          requirementBaselineComplete: snapshot.requirementBaselineComplete === false ? false : baseline.complete,
        }
      : {}),
    ...(snapshot.executionRequirements
      ? {
          executionRequirements: snapshot.executionRequirements.slice(-MAX_ARRAY_ENTRIES).map((requirement) => {
            const sanitized = sanitizeExecutionRequirement(requirement);
            return {
              ...sanitized,
              id: boundedString(sanitized.id, 160),
              sourceExcerpt: boundedString(sanitized.sourceExcerpt, 2_000),
              parameters: compactRecord(sanitized.parameters, 2_048),
              ...(sanitized.waiver
                ? {
                    waiver: {
                      authorizedBy: sanitized.waiver.authorizedBy,
                      reason: boundedString(sanitized.waiver.reason, 1_000),
                      evidenceRefs: uniqueStrings(sanitized.waiver.evidenceRefs),
                    },
                  }
                : {}),
            };
          }),
        }
      : {}),
    ...(snapshot.requirementEvaluations
      ? {
          requirementEvaluations: snapshot.requirementEvaluations.slice(-MAX_ARRAY_ENTRIES).map((evaluation) => {
            const sanitized = sanitizeRequirementEvaluation(evaluation);
            return {
              ...sanitized,
              requirementId: boundedString(sanitized.requirementId, 160),
              evidence: uniqueStrings(sanitized.evidence).slice(-8),
            };
          }),
        }
      : {}),
    ...(snapshot.taskArtifactFingerprints
      ? { taskArtifactFingerprints: boundedArtifactFingerprints(snapshot.taskArtifactFingerprints) }
      : {}),
  };
}

function serializedBytes(snapshot: ExecutionCheckpointSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

/**
 * Deterministically shrink a checkpoint projection while preserving the
 * newest history entries. Full raw arguments/results are never introduced by
 * this function; older authoritative audit rows remain untouched.
 */
export function boundExecutionCheckpointSnapshot(snapshot: ExecutionCheckpointSnapshot): ExecutionCheckpointSnapshot {
  let bounded = normalizeSnapshot(snapshot);
  const arrayKeys: Array<keyof ExecutionCheckpointSnapshot> = [
    "completedWork",
    "tests",
    "recoveryAttempts",
    "unresolvedFailures",
    "pendingWork",
    "decisions",
    "hardRequirements",
    "acceptanceCriteria",
    "prohibitedActions",
    "filesChanged",
    "providerContinuationRefs",
    "evidenceRequired",
    "taskArtifactFingerprints",
  ];

  while (serializedBytes(bounded) > MAX_EXECUTION_CHECKPOINT_BYTES) {
    const largestKey = arrayKeys
      .filter((key) => Array.isArray(bounded[key]) && (bounded[key] as unknown[]).length > 0)
      .sort((left, right) => JSON.stringify(bounded[right]).length - JSON.stringify(bounded[left]).length)[0];
    if (!largestKey) break;
    const values = bounded[largestKey] as unknown[];
    bounded = { ...bounded, [largestKey]: values.slice(1) } as ExecutionCheckpointSnapshot;
  }

  if (serializedBytes(bounded) > MAX_EXECUTION_CHECKPOINT_BYTES) {
    bounded = {
      ...bounded,
      originalMission: boundedString(bounded.originalMission, 2_048),
      hardRequirements: [],
      prohibitedActions: [],
      acceptanceCriteria: [],
      decisions: [],
      completedWork: [],
      filesChanged: [],
      ...(bounded.requirementBaselinePaths
        ? {
            requirementBaselinePaths: bounded.requirementBaselinePaths,
            ...(bounded.requirementBaselinePathCount !== undefined ? { requirementBaselinePathCount: bounded.requirementBaselinePathCount } : {}),
            ...(bounded.requirementBaselineIdentityHash ? { requirementBaselineIdentityHash: bounded.requirementBaselineIdentityHash } : {}),
            ...(bounded.requirementBaselineComplete !== undefined ? { requirementBaselineComplete: bounded.requirementBaselineComplete } : {}),
          }
        : {}),
      gitStatus: boundedString(bounded.gitStatus, 2_048),
      tests: [],
      unresolvedFailures: [],
      recoveryAttempts: [],
      pendingWork: [],
      approvals: {},
      providerRouting: {},
      providerContinuationRefs: [],
      evidenceRequired: [],
      ...(bounded.executionRequirements
        ? { executionRequirements: bounded.executionRequirements.map(compactExecutionRequirement) }
        : {}),
      ...(bounded.requirementEvaluations
        ? { requirementEvaluations: bounded.requirementEvaluations.map(compactRequirementEvaluation) }
        : {}),
      ...(bounded.taskArtifactFingerprints
        ? { taskArtifactFingerprints: bounded.taskArtifactFingerprints }
        : {}),
    };
  }

  if (serializedBytes(bounded) > MAX_EXECUTION_CHECKPOINT_BYTES) {
    throw new Error(`Execution checkpoint projection exceeds ${MAX_EXECUTION_CHECKPOINT_BYTES} bytes after deterministic truncation`);
  }
  return bounded;
}

/** Build a bounded snapshot from append-only call/event records. */
export function projectCheckpointSnapshot(input: CheckpointSnapshotProjectionInput): ExecutionCheckpointSnapshot {
  const snapshot = {
    ...input.snapshot,
    ...(input.completedCalls ? { completedWork: input.completedCalls.map(summarizeCheckpointCall) } : {}),
    ...(input.testCalls ? { tests: input.testCalls.map(summarizeCheckpointTest) } : {}),
    ...(input.failedCalls ? { unresolvedFailures: input.failedCalls.map((call) => summarizeCheckpointFailure(call)) } : {}),
    ...(input.recoveryAttempts ? { recoveryAttempts: input.recoveryAttempts.map(summarizeCheckpointRecovery) } : {}),
  };
  return boundExecutionCheckpointSnapshot(snapshot);
}

// Descriptive aliases keep the boundary easy to discover at call sites.
export const buildBoundedCheckpointSnapshot = projectCheckpointSnapshot;
export const buildExecutionCheckpointSnapshot = projectCheckpointSnapshot;
