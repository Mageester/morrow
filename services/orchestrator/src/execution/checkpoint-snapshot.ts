import { createHash } from "node:crypto";
import type { ExecutionCheckpointSnapshot } from "../repositories/execution-continuity.js";
import { redactSecrets, redactSecretsDeep } from "../provider/credentials.js";
import { sanitizeExecutionRequirement, sanitizeRequirementEvaluation, type ExecutionRequirement, type RequirementEvaluation } from "./requirements.js";

/** Hard upper bound for one serialized internal recovery checkpoint. */
export const MAX_EXECUTION_CHECKPOINT_BYTES = 131_072;

const MAX_ARRAY_ENTRIES = 256;
const INITIAL_CATEGORY_BYTES = 8_192;
const COMPACTED_MARKER_PREFIX = "checkpoint-compacted";

interface ExecutionCheckpointCategoryCompaction {
  compacted: boolean;
  originalCount: number;
  retainedCount: number;
  digest: string;
}

interface ExecutionCheckpointCompaction {
  version: 1;
  compacted: boolean;
  originalBytes: number;
  categories: Record<string, ExecutionCheckpointCategoryCompaction>;
}

type CategoryStates = Record<string, ExecutionCheckpointCategoryCompaction>;

interface NormalizedSnapshot {
  snapshot: ExecutionCheckpointSnapshot;
  categories: CategoryStates;
  originalBytes: number;
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

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
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
  } catch {
    serialized = String(value);
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 24);
}

function boundedString(value: string, maxBytes = 8_192): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = `…[truncated:${hash(value)}]`;
  if (Buffer.byteLength(suffix, "utf8") >= maxBytes) {
    return Buffer.from(suffix, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  let end = Math.max(0, Math.floor(maxBytes * 0.75));
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes - Buffer.byteLength(suffix, "utf8")) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
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

function safeRedactedString(value: unknown): string {
  const text = safeString(value);
  try {
    return redactSecrets(text);
  } catch {
    return "";
  }
}

function stringArrayValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const safe = boundedString(safeRedactedString(item));
    if (!values.includes(safe)) values.push(safe);
  }
  return values;
}

function uniqueStrings(values: unknown): string[] {
  return stringArrayValues(values).slice(-MAX_ARRAY_ENTRIES);
}

function normalizedArtifactFingerprints(values: unknown): Array<{ path: string; contentHash: string }> {
  if (!Array.isArray(values)) return [];
  return values
    .flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const entry = value as Record<string, unknown>;
      if (typeof entry.path !== "string" || typeof entry.contentHash !== "string") return [];
      return [{
        path: boundedString(safeRedactedString(entry.path), 1_024),
        contentHash: boundedString(safeRedactedString(entry.contentHash), 160),
      }];
    });
}

function boundedArtifactFingerprints(values: unknown): Array<{ path: string; contentHash: string }> {
  return normalizedArtifactFingerprints(values).slice(-MAX_ARRAY_ENTRIES);
}

function boundedBaselinePaths(values: unknown, maxBytes = 24 * 1024): { paths: string[]; complete: boolean; count: number; identityHash: string } {
  const unique = stringArrayValues(values);
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

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function safeSerializedBytes(value: unknown): number {
  try {
    return serializedBytes(redactSecretsDeep(value));
  } catch {
    return 0;
  }
}

function priorCategoryState(value: unknown, category: string): ExecutionCheckpointCategoryCompaction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const compaction = (value as Record<string, unknown>).compaction;
  if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) return undefined;
  const categories = (compaction as Record<string, unknown>).categories;
  if (!categories || typeof categories !== "object" || Array.isArray(categories)) return undefined;
  const state = (categories as Record<string, unknown>)[category];
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  const entry = state as Record<string, unknown>;
  if (typeof entry.digest !== "string" || !/^[a-f0-9]{24}$/.test(entry.digest)) return undefined;
  const originalCount = entry.originalCount;
  const retainedCount = entry.retainedCount;
  if (!Number.isSafeInteger(originalCount) || (originalCount as number) < 0) return undefined;
  if (!Number.isSafeInteger(retainedCount) || (retainedCount as number) < 0) return undefined;
  if (typeof entry.compacted !== "boolean") return undefined;
  return {
    compacted: entry.compacted,
    originalCount: originalCount as number,
    retainedCount: retainedCount as number,
    digest: entry.digest,
  };
}

function priorOriginalBytes(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const compaction = (value as Record<string, unknown>).compaction;
  if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) return undefined;
  const bytes = (compaction as Record<string, unknown>).originalBytes;
  return Number.isSafeInteger(bytes) && (bytes as number) >= 0 ? bytes as number : undefined;
}

function checkpointCompactedMarker(category: string, state: ExecutionCheckpointCategoryCompaction): string {
  return `[${COMPACTED_MARKER_PREFIX}:${category} count=${state.originalCount} digest=${state.digest}]`;
}

function isCompactedMarker(value: unknown, category: string): boolean {
  return typeof value === "string" && value.startsWith(`[${COMPACTED_MARKER_PREFIX}:${category} `) && value.endsWith("]");
}

function isCompactedEntry(value: unknown, category: string): boolean {
  if (isCompactedMarker(value, category)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return [entry.command, entry.id, entry.requirementId, entry.path, entry.summary].some((field) => isCompactedMarker(field, category));
}

function updateCategoryState(
  state: ExecutionCheckpointCategoryCompaction,
  updates: Partial<ExecutionCheckpointCategoryCompaction>,
): ExecutionCheckpointCategoryCompaction {
  return {
    ...state,
    ...updates,
    compacted: state.compacted || updates.compacted === true,
  };
}

function compactStringCategory(
  values: string[],
  category: string,
  state: ExecutionCheckpointCategoryCompaction,
  maxBytes: number,
): { values: string[]; state: ExecutionCheckpointCategoryCompaction } {
  if (!state.compacted && serializedBytes(values) <= maxBytes) {
    return { values, state: updateCategoryState(state, { retainedCount: values.length }) };
  }

  const marker = checkpointCompactedMarker(category, state);
  const itemLimit = Math.max(64, Math.floor(Math.max(0, maxBytes - serializedBytes([marker])) / 2));
  const head = values.length > 0 && values[0] !== marker ? boundedString(values[0]!, itemLimit) : "";
  const tail = values.length > 1 && values.at(-1) !== marker ? boundedString(values.at(-1)!, itemLimit) : "";
  const candidates = [
    [head, marker, tail].filter(Boolean),
    [head, marker].filter(Boolean),
    [marker, tail].filter(Boolean),
    [marker],
  ];
  const selected = candidates.find((candidate) => serializedBytes(candidate) <= maxBytes) ?? [marker];
  return {
    values: selected,
    state: updateCategoryState(state, {
      compacted: true,
      retainedCount: selected.filter((item) => !isCompactedMarker(item, category)).length,
    }),
  };
}

function compactScalarCategory(
  value: string,
  category: string,
  state: ExecutionCheckpointCategoryCompaction,
  maxBytes: number,
): { value: string; state: ExecutionCheckpointCategoryCompaction } {
  if (!state.compacted && serializedBytes(value) <= maxBytes) {
    return { value, state: updateCategoryState(state, { retainedCount: value ? 1 : 0 }) };
  }
  const marker = checkpointCompactedMarker(category, state);
  const available = Math.max(0, maxBytes - serializedBytes(marker) - 3);
  // Rebound an already-compacted scalar from its retained prefix. Keeping the
  // marker as a suffix makes repeated rollover/restart normalization stable
  // instead of appending a fresh marker on every pass.
  const retainedSource = value.endsWith(marker)
    ? value.slice(0, -marker.length).replace(/\n$/, "")
    : value;
  const retained = boundedString(retainedSource, available);
  const compacted = retained ? `${retained}\n${marker}` : marker;
  return {
    value: serializedBytes(compacted) <= maxBytes ? compacted : boundedString(marker, maxBytes),
    state: updateCategoryState(state, { compacted: true, retainedCount: retained ? 1 : 0 }),
  };
}

function compactRecordCategory(
  value: Record<string, unknown>,
  category: string,
  state: ExecutionCheckpointCategoryCompaction,
  maxBytes: number,
): { value: Record<string, unknown>; state: ExecutionCheckpointCategoryCompaction } {
  if (!state.compacted && serializedBytes(value) <= maxBytes) {
    return { value, state: updateCategoryState(state, { retainedCount: Object.keys(value).length }) };
  }
  const marker = checkpointCompactedMarker(category, state);
  return {
    value: { summaryHash: state.digest, summary: marker },
    state: updateCategoryState(state, { compacted: true, retainedCount: 0 }),
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
  const sanitizedValue = redactStructured(value);
  const sanitized = sanitizedValue && typeof sanitizedValue === "object" && !Array.isArray(sanitizedValue)
    ? sanitizedValue as Record<string, unknown>
    : {};
  if (serializedBytes(sanitized) <= maxBytes) return sanitized;
  return { summaryHash: hash(sanitized), summary: "large structured checkpoint field omitted" };
}

function compactExecutionRequirement(requirement: ExecutionRequirement, sourceLimit = 2_000, parameterLimit = 2_048): ExecutionRequirement {
  const { waiver, ...requirementFields } = requirement;
  const waiverAuthority = waiver && typeof waiver === "object" && (waiver.authorizedBy === "user" || waiver.authorizedBy === "mission_ledger")
    ? waiver.authorizedBy
    : undefined;
  const waiverAuthorityInvalid = waiver !== undefined && waiverAuthority === undefined;
  const candidate = {
    ...requirementFields,
    id: safeRedactedString(requirement.id),
    sourceExcerpt: safeRedactedString(requirement.sourceExcerpt),
    ...(waiverAuthorityInvalid ? { status: "unevaluated" as const } : {}),
    parameters: requirement.parameters && typeof requirement.parameters === "object" && !Array.isArray(requirement.parameters)
      ? requirement.parameters
      : {},
    ...(waiver && typeof waiver === "object" && waiverAuthority
      ? {
          waiver: {
            authorizedBy: waiverAuthority,
            reason: safeRedactedString(waiver.reason),
            evidenceRefs: uniqueStrings(waiver.evidenceRefs),
          },
        }
      : {}),
  };
  let sanitized: ExecutionRequirement;
  try {
    sanitized = sanitizeExecutionRequirement(candidate);
  } catch {
    sanitized = {
      id: safeRedactedString(requirement.id),
      kind: null,
      sourceExcerpt: safeRedactedString(requirement.sourceExcerpt),
      parameters: {},
      authoritative: requirement.authoritative === true,
      status: waiverAuthorityInvalid
        ? "unevaluated"
        : requirement.status === "failed" || requirement.status === "verified" || requirement.status === "waived" ? requirement.status : "unevaluated",
    };
  }
  return {
    id: boundedString(sanitized.id, 128),
    kind: sanitized.kind,
    sourceExcerpt: boundedString(sanitized.sourceExcerpt, sourceLimit),
    parameters: compactRecord(sanitized.parameters, parameterLimit),
    authoritative: sanitized.authoritative === true,
    status: sanitized.status === "failed" || sanitized.status === "verified" || sanitized.status === "waived" ? sanitized.status : "unevaluated",
    ...(sanitized.waiver
      ? {
          waiver: {
            authorizedBy: sanitized.waiver.authorizedBy === "mission_ledger" ? "mission_ledger" as const : "user" as const,
            reason: boundedString(sanitized.waiver.reason, 160),
            evidenceRefs: uniqueStrings(sanitized.waiver.evidenceRefs).slice(-16),
          },
        }
      : {}),
  };
}

function compactRequirementEvaluation(evaluation: RequirementEvaluation, evidenceLimit = 4): RequirementEvaluation {
  const candidate = {
    ...evaluation,
    requirementId: safeRedactedString(evaluation.requirementId),
    evidence: uniqueStrings(evaluation.evidence),
  };
  let sanitized: RequirementEvaluation;
  try {
    sanitized = sanitizeRequirementEvaluation(candidate);
  } catch {
    sanitized = {
      requirementId: safeRedactedString(evaluation.requirementId),
      kind: null,
      status: "unevaluated",
      evidence: [],
    };
  }
  return {
    requirementId: boundedString(sanitized.requirementId, 128),
    kind: sanitized.kind,
    status: sanitized.status === "failed" || sanitized.status === "verified" || sanitized.status === "waived" ? sanitized.status : "unevaluated",
    evidence: uniqueStrings(sanitized.evidence).slice(-evidenceLimit),
    ...(sanitized.observedFileType ? { observedFileType: sanitized.observedFileType } : {}),
  };
}

function normalizeTests(value: unknown): Array<{ command: string; exitCode: number | null; result: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const test = item as Record<string, unknown>;
    const command = sanitizeActionableText(safeString(test.command), 4_096);
    const result = sanitizeActionableText(safeString(test.result), 4_096);
    const exitCode = typeof test.exitCode === "number" && Number.isFinite(test.exitCode) ? test.exitCode : null;
    return [{ command, exitCode, result }];
  }).slice(-MAX_ARRAY_ENTRIES);
}

function safeRecord(value: unknown): Record<string, unknown> {
  try {
    const sanitized = redactSecretsDeep(value);
    return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? sanitized as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function categoryState(
  rawValue: unknown,
  normalizedValue: unknown,
  category: string,
  prior: ExecutionCheckpointCategoryCompaction | undefined,
  originalCount: number,
  digestValue: unknown = rawValue,
  compactedOverride?: boolean,
): ExecutionCheckpointCategoryCompaction {
  // A previously bounded snapshot is already canonical. Preserve its loss
  // accounting while re-reading it; recomputing retainedCount from a marker
  // sample would make the same checkpoint drift after restart.
  if (prior) return { ...prior };
  return {
    compacted: compactedOverride ?? (safeSerializedBytes(rawValue) !== serializedBytes(normalizedValue)),
    originalCount,
    retainedCount: Array.isArray(normalizedValue) ? normalizedValue.length : normalizedValue ? 1 : 0,
    digest: hash(digestValue),
  };
}

function normalizeStringCategory(
  rawValue: unknown,
  category: string,
  prior: ExecutionCheckpointCategoryCompaction | undefined,
): { values: string[]; state: ExecutionCheckpointCategoryCompaction } {
  const source = stringArrayValuesWithChange(rawValue);
  const values = source.values.slice(-MAX_ARRAY_ENTRIES);
  const rawCount = Array.isArray(rawValue) ? rawValue.length : 0;
  const changed = prior ? prior.compacted : source.changed || source.values.length > MAX_ARRAY_ENTRIES;
  const state = categoryState(rawValue, values, category, prior, rawCount, source.values, changed);
  const result = compactStringCategory(values, category, updateCategoryState(state, { compacted: changed }), INITIAL_CATEGORY_BYTES);
  return result;
}

function stringArrayValuesWithChange(value: unknown): { values: string[]; changed: boolean } {
  if (!Array.isArray(value)) return { values: [], changed: false };
  const values: string[] = [];
  let changed = false;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const redacted = safeRedactedString(item);
    const bounded = boundedString(redacted);
    changed ||= bounded !== redacted;
    if (!values.includes(bounded)) values.push(bounded);
  }
  return { values, changed };
}

function normalizeRecordCategory(
  rawValue: unknown,
  category: string,
  prior: ExecutionCheckpointCategoryCompaction | undefined,
): { value: Record<string, unknown>; state: ExecutionCheckpointCategoryCompaction } {
  const full = safeRecord(rawValue);
  const bounded = redactStructured(full);
  const boundedRecord = bounded && typeof bounded === "object" && !Array.isArray(bounded)
    ? bounded as Record<string, unknown>
    : {};
  const rawRecord = !!rawValue && typeof rawValue === "object" && !Array.isArray(rawValue);
  const compacted = prior
    ? prior.compacted
    : rawRecord && (serializedBytes(full) > INITIAL_CATEGORY_BYTES || serializedBytes(full) !== serializedBytes(boundedRecord));
  const state = categoryState(rawValue, boundedRecord, category, prior, Object.keys(full).length, full, compacted);
  const result = compactRecordCategory(boundedRecord, category, updateCategoryState(state, { compacted }), INITIAL_CATEGORY_BYTES);
  return result;
}

function normalizeRequirements(value: unknown, prior: ExecutionCheckpointCategoryCompaction | undefined): { values: ExecutionRequirement[]; state: ExecutionCheckpointCategoryCompaction } | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalizedValues = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const requirement = item as ExecutionRequirement;
    if (typeof requirement.id !== "string" || typeof requirement.sourceExcerpt !== "string") return [];
    try {
      return [compactExecutionRequirement(requirement)];
    } catch {
      return [];
    }
  });
  const values = normalizedValues.slice(-MAX_ARRAY_ENTRIES);
  const state = categoryState(value, values, "executionRequirements", prior, value.length, normalizedValues);
  return { values, state: updateCategoryState(state, { compacted: prior?.compacted === true || value.length > MAX_ARRAY_ENTRIES }) };
}

function normalizeEvaluations(value: unknown, prior: ExecutionCheckpointCategoryCompaction | undefined): { values: RequirementEvaluation[]; state: ExecutionCheckpointCategoryCompaction } | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalizedValues = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const evaluation = item as RequirementEvaluation;
    if (typeof evaluation.requirementId !== "string") return [];
    return [compactRequirementEvaluation(evaluation, 8)];
  });
  const values = normalizedValues.slice(-MAX_ARRAY_ENTRIES);
  const state = categoryState(value, values, "requirementEvaluations", prior, value.length, normalizedValues);
  return { values, state: updateCategoryState(state, { compacted: prior?.compacted === true || value.length > MAX_ARRAY_ENTRIES }) };
}

function normalizeSnapshot(snapshot: ExecutionCheckpointSnapshot): NormalizedSnapshot {
  const raw = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as unknown as Record<string, unknown>
    : {};
  const originalBytes = priorOriginalBytes(raw) ?? safeSerializedBytes(raw);
  const categories: CategoryStates = {};
  const prior = (category: string) => priorCategoryState(raw, category);

  const missionRaw = safeRedactedString(raw.originalMission);
  const missionBound = boundedString(missionRaw);
  const missionState = categoryState(raw.originalMission, missionBound, "originalMission", prior("originalMission"), missionRaw ? 1 : 0, missionRaw, missionBound !== missionRaw);
  const mission = compactScalarCategory(missionBound, "originalMission", updateCategoryState(missionState, { compacted: missionState.compacted || missionBound !== missionRaw }), INITIAL_CATEGORY_BYTES);
  categories.originalMission = mission.state;

  const stringFields = [
    "hardRequirements", "prohibitedActions", "acceptanceCriteria", "decisions", "completedWork",
    "filesChanged", "unresolvedFailures", "recoveryAttempts", "pendingWork", "providerContinuationRefs", "evidenceRequired",
  ] as const;
  const strings = Object.fromEntries(stringFields.map((field) => {
    const result = normalizeStringCategory(raw[field], field, prior(field));
    categories[field] = result.state;
    return [field, result.values];
  })) as Record<(typeof stringFields)[number], string[]>;

  const phaseRaw = safeRedactedString(raw.currentPhase);
  const phaseBound = boundedString(phaseRaw);
  const phaseState = categoryState(raw.currentPhase, phaseBound, "currentPhase", prior("currentPhase"), phaseRaw ? 1 : 0, phaseRaw, phaseBound !== phaseRaw);
  const phase = compactScalarCategory(phaseBound, "currentPhase", updateCategoryState(phaseState, { compacted: phaseState.compacted || phaseBound !== phaseRaw }), INITIAL_CATEGORY_BYTES);
  categories.currentPhase = phase.state;

  const gitRaw = safeRedactedString(raw.gitStatus);
  const gitBound = boundedString(gitRaw);
  const gitState = categoryState(raw.gitStatus, gitBound, "gitStatus", prior("gitStatus"), gitRaw ? 1 : 0, gitRaw, gitBound !== gitRaw);
  const git = compactScalarCategory(gitBound, "gitStatus", updateCategoryState(gitState, { compacted: gitState.compacted || gitBound !== gitRaw }), INITIAL_CATEGORY_BYTES);
  categories.gitStatus = git.state;

  const tests = normalizeTests(raw.tests);
  const testsNeedCompaction = Array.isArray(raw.tests) && (
    raw.tests.length > MAX_ARRAY_ENTRIES || raw.tests.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const test = item as Record<string, unknown>;
      return Buffer.byteLength(safeRedactedString(test.command), "utf8") > 4_096
        || Buffer.byteLength(safeRedactedString(test.result), "utf8") > 4_096;
    })
  );
  const testsState = categoryState(raw.tests, tests, "tests", prior("tests"), Array.isArray(raw.tests) ? raw.tests.length : 0, tests, testsNeedCompaction);
  const boundedTests = compactTests(tests, "tests", updateCategoryState(testsState, { compacted: prior("tests")?.compacted === true || testsNeedCompaction }), INITIAL_CATEGORY_BYTES);
  categories.tests = boundedTests.state;

  const approvals = normalizeRecordCategory(raw.approvals, "approvals", prior("approvals"));
  const providerRouting = normalizeRecordCategory(raw.providerRouting, "providerRouting", prior("providerRouting"));
  categories.approvals = approvals.state;
  categories.providerRouting = providerRouting.state;

  const baseline = Array.isArray(raw.requirementBaselinePaths) ? boundedBaselinePaths(raw.requirementBaselinePaths) : undefined;
  const priorBaseline = prior("requirementBaselinePaths");
  if (baseline) {
    const baselineState = updateCategoryState(
      categoryState(raw.requirementBaselinePaths, baseline.paths, "requirementBaselinePaths", priorBaseline, baseline.count, baseline.identityHash),
      { digest: priorBaseline?.digest ?? baseline.identityHash },
    );
    categories.requirementBaselinePaths = updateCategoryState(baselineState, {
      compacted: prior("requirementBaselinePaths")?.compacted === true || !baseline.complete,
      retainedCount: baseline.paths.length,
    });
  }

  const requirements = normalizeRequirements(raw.executionRequirements, prior("executionRequirements"));
  const evaluations = normalizeEvaluations(raw.requirementEvaluations, prior("requirementEvaluations"));
  if (requirements) categories.executionRequirements = requirements.state;
  if (evaluations) categories.requirementEvaluations = evaluations.state;

  const rawArtifacts = raw.taskArtifactFingerprints;
  const artifactInput = Array.isArray(rawArtifacts) ? rawArtifacts as unknown[] : undefined;
  const normalizedArtifacts = artifactInput ? normalizedArtifactFingerprints(artifactInput) : undefined;
  const artifacts = normalizedArtifacts ? normalizedArtifacts.slice(-MAX_ARRAY_ENTRIES) : undefined;
  if (artifacts && artifactInput && normalizedArtifacts) {
    const state = categoryState(artifactInput, artifacts, "taskArtifactFingerprints", prior("taskArtifactFingerprints"), artifactInput.length, normalizedArtifacts);
    categories.taskArtifactFingerprints = updateCategoryState(state, { compacted: prior("taskArtifactFingerprints")?.compacted === true || artifacts.length !== artifactInput.length });
  }

  const processValues = Array.isArray(raw.runningProcesses)
    ? raw.runningProcesses.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const process = item as Record<string, unknown>;
        return [{ processId: boundedString(safeRedactedString(process.processId), 100), command: boundedString(safeRedactedString(process.command), 300) }];
      }).slice(-10)
    : undefined;

  const result: ExecutionCheckpointSnapshot = {
    version: 1,
    originalMission: mission.value,
    hardRequirements: strings.hardRequirements,
    prohibitedActions: strings.prohibitedActions,
    acceptanceCriteria: strings.acceptanceCriteria,
    decisions: strings.decisions,
    completedWork: strings.completedWork,
    currentPhase: phase.value,
    filesChanged: strings.filesChanged,
    gitStatus: git.value,
    tests: boundedTests.values,
    unresolvedFailures: strings.unresolvedFailures,
    recoveryAttempts: strings.recoveryAttempts,
    pendingWork: strings.pendingWork,
    approvals: approvals.value,
    taskId: boundedString(safeRedactedString(raw.taskId), 256),
    missionId: raw.missionId === null || raw.missionId === undefined ? null : boundedString(safeRedactedString(raw.missionId), 256),
    providerRouting: providerRouting.value,
    providerContinuationRefs: strings.providerContinuationRefs,
    evidenceRequired: strings.evidenceRequired,
    ...(baseline
      ? {
          requirementBaselinePaths: baseline.paths,
          requirementBaselinePathCount: priorBaseline?.compacted ? priorBaseline.originalCount : baseline.count,
          requirementBaselineIdentityHash: priorBaseline?.compacted ? priorBaseline.digest : baseline.identityHash,
          requirementBaselineComplete: raw.requirementBaselineComplete === false ? false : baseline.complete,
        }
      : {}),
    ...(requirements ? { executionRequirements: requirements.values } : {}),
    ...(evaluations ? { requirementEvaluations: evaluations.values } : {}),
    ...(artifacts ? { taskArtifactFingerprints: artifacts } : {}),
    ...(processValues && processValues.length > 0 ? { runningProcesses: processValues } : {}),
  };
  return { snapshot: result, categories, originalBytes };
}

function compactTests(
  values: Array<{ command: string; exitCode: number | null; result: string }>,
  category: string,
  state: ExecutionCheckpointCategoryCompaction,
  maxBytes: number,
): { values: Array<{ command: string; exitCode: number | null; result: string }>; state: ExecutionCheckpointCategoryCompaction } {
  if (!state.compacted && serializedBytes(values) <= maxBytes) return { values, state: updateCategoryState(state, { retainedCount: values.length }) };
  const marker = checkpointCompactedMarker(category, state);
  const markerEntry = { command: marker, exitCode: null, result: marker };
  const selected = [values[0], markerEntry, values.at(-1)].filter((value, index, array) => value !== undefined && (index === 0 || serializedBytes(value) > 0 && JSON.stringify(value) !== JSON.stringify(array[index - 1]))) as Array<{ command: string; exitCode: number | null; result: string }>;
  const bounded = serializedBytes(selected) <= maxBytes ? selected : [markerEntry];
  return { values: bounded, state: updateCategoryState(state, { compacted: true, retainedCount: bounded.filter((item) => !isCompactedEntry(item, category)).length }) };
}

function compactRequirementList(
  values: ExecutionRequirement[],
  category: string,
  state: ExecutionCheckpointCategoryCompaction,
  maxBytes: number,
  sourceLimit: number,
  parameterLimit: number,
): { values: ExecutionRequirement[]; state: ExecutionCheckpointCategoryCompaction } {
  const compactedValues = values.map((value) => compactExecutionRequirement(value, sourceLimit, parameterLimit));
  const entryChanged = serializedBytes(compactedValues) !== serializedBytes(values);
  const nextState = updateCategoryState(state, { compacted: state.compacted || entryChanged });
  if (serializedBytes(compactedValues) <= maxBytes && !nextState.compacted) return { values: compactedValues, state: updateCategoryState(nextState, { retainedCount: compactedValues.length }) };
  if (serializedBytes(compactedValues) <= maxBytes && nextState.compacted && values.length <= MAX_ARRAY_ENTRIES) return { values: compactedValues, state: updateCategoryState(nextState, { retainedCount: compactedValues.length }) };
  const marker = checkpointCompactedMarker(category, nextState);
  const markerEntry: ExecutionRequirement = { id: marker, kind: null, sourceExcerpt: marker, parameters: {}, authoritative: false, status: "unevaluated" };
  const selected = [compactedValues[0], markerEntry, compactedValues.at(-1)].filter((value, index, array) => value !== undefined && (index === 0 || JSON.stringify(value) !== JSON.stringify(array[index - 1]))) as ExecutionRequirement[];
  const bounded = serializedBytes(selected) <= maxBytes ? selected : [markerEntry];
  return { values: bounded, state: updateCategoryState(nextState, { compacted: true, retainedCount: bounded.filter((item) => !isCompactedEntry(item, category)).length }) };
}

function compactEvaluationList(
  values: RequirementEvaluation[],
  category: string,
  state: ExecutionCheckpointCategoryCompaction,
  maxBytes: number,
  evidenceLimit: number,
): { values: RequirementEvaluation[]; state: ExecutionCheckpointCategoryCompaction } {
  const compactedValues = values.map((value) => compactRequirementEvaluation(value, evidenceLimit));
  const entryChanged = serializedBytes(compactedValues) !== serializedBytes(values);
  const nextState = updateCategoryState(state, { compacted: state.compacted || entryChanged });
  if (serializedBytes(compactedValues) <= maxBytes && (!nextState.compacted || values.length <= MAX_ARRAY_ENTRIES)) return { values: compactedValues, state: updateCategoryState(nextState, { retainedCount: compactedValues.length }) };
  const marker = checkpointCompactedMarker(category, nextState);
  const markerEntry: RequirementEvaluation = { requirementId: marker, kind: null, status: "unevaluated", evidence: [marker] };
  const selected = [compactedValues[0], markerEntry, compactedValues.at(-1)].filter((value, index, array) => value !== undefined && (index === 0 || JSON.stringify(value) !== JSON.stringify(array[index - 1]))) as RequirementEvaluation[];
  const bounded = serializedBytes(selected) <= maxBytes ? selected : [markerEntry];
  return { values: bounded, state: updateCategoryState(nextState, { compacted: true, retainedCount: bounded.filter((item) => !isCompactedEntry(item, category)).length }) };
}

function compactArtifactList(
  values: Array<{ path: string; contentHash: string }>,
  category: string,
  state: ExecutionCheckpointCategoryCompaction,
  maxBytes: number,
): { values: Array<{ path: string; contentHash: string }>; state: ExecutionCheckpointCategoryCompaction } {
  if (!state.compacted && serializedBytes(values) <= maxBytes) return { values, state: updateCategoryState(state, { retainedCount: values.length }) };
  const marker = checkpointCompactedMarker(category, state);
  const markerEntry = { path: marker, contentHash: state.digest };
  const selected = [values[0], markerEntry, values.at(-1)].filter((value, index, array) => value !== undefined && (index === 0 || JSON.stringify(value) !== JSON.stringify(array[index - 1]))) as Array<{ path: string; contentHash: string }>;
  const bounded = serializedBytes(selected) <= maxBytes ? selected : [markerEntry];
  return { values: bounded, state: updateCategoryState(state, { compacted: true, retainedCount: bounded.filter((item) => !isCompactedEntry(item, category)).length }) };
}

function compactToLevel(
  bounded: ExecutionCheckpointSnapshot,
  categories: CategoryStates,
  level: number,
): void {
  const arrayLimits = level === 1 ? 8_192 : level === 2 ? 4_096 : level === 3 ? 2_048 : 1_024;
  const stringFields = [
    "hardRequirements", "prohibitedActions", "acceptanceCriteria", "decisions", "completedWork",
    "filesChanged", "unresolvedFailures", "recoveryAttempts", "pendingWork", "providerContinuationRefs", "evidenceRequired",
  ] as const;
  for (const field of stringFields) {
    const result = compactStringCategory(bounded[field], field, categories[field]!, arrayLimits);
    bounded[field] = result.values;
    categories[field] = result.state;
  }
  for (const field of ["originalMission", "currentPhase", "gitStatus"] as const) {
    const result = compactScalarCategory(bounded[field], field, categories[field]!, arrayLimits);
    bounded[field] = result.value;
    categories[field] = result.state;
  }
  for (const field of ["approvals", "providerRouting"] as const) {
    const result = compactRecordCategory(bounded[field], field, categories[field]!, arrayLimits);
    bounded[field] = result.value;
    categories[field] = result.state;
  }
  const testResult = compactTests(bounded.tests, "tests", categories.tests!, arrayLimits);
  bounded.tests = testResult.values;
  categories.tests = testResult.state;

  if (bounded.executionRequirements && categories.executionRequirements) {
    const result = compactRequirementList(
      bounded.executionRequirements,
      "executionRequirements",
      categories.executionRequirements,
      level >= 3 ? 8_192 : MAX_EXECUTION_CHECKPOINT_BYTES,
      level >= 2 ? 64 : 128,
      level >= 2 ? 128 : 256,
    );
    bounded.executionRequirements = result.values;
    categories.executionRequirements = result.state;
  }
  if (bounded.requirementEvaluations && categories.requirementEvaluations) {
    const result = compactEvaluationList(
      bounded.requirementEvaluations,
      "requirementEvaluations",
      categories.requirementEvaluations,
      level >= 3 ? 8_192 : MAX_EXECUTION_CHECKPOINT_BYTES,
      level >= 2 ? 2 : 4,
    );
    bounded.requirementEvaluations = result.values;
    categories.requirementEvaluations = result.state;
  }
  if (bounded.taskArtifactFingerprints && categories.taskArtifactFingerprints) {
    const result = compactArtifactList(bounded.taskArtifactFingerprints, "taskArtifactFingerprints", categories.taskArtifactFingerprints, level >= 3 ? 4_096 : 16_384);
    bounded.taskArtifactFingerprints = result.values;
    categories.taskArtifactFingerprints = result.state;
  }
  if (bounded.requirementBaselinePaths && categories.requirementBaselinePaths && level >= 3) {
    bounded.requirementBaselinePaths = bounded.requirementBaselinePaths.slice(0, 8);
    categories.requirementBaselinePaths = updateCategoryState(categories.requirementBaselinePaths, { compacted: true, retainedCount: bounded.requirementBaselinePaths.length });
    bounded.requirementBaselineComplete = false;
  }
}

function compactionMetadata(originalBytes: number, categories: CategoryStates): ExecutionCheckpointCompaction {
  const ordered = Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, value]));
  return {
    version: 1,
    compacted: Object.values(categories).some((category) => category.compacted),
    originalBytes,
    categories: ordered,
  };
}

/**
 * Deterministically shrink a checkpoint projection while preserving a
 * semantic value or an explicit category digest for every field. Full raw
 * arguments/results remain in append-only audit rows; this function only
 * prepares the restart/provider projection.
 */
export function boundExecutionCheckpointSnapshot(snapshot: ExecutionCheckpointSnapshot): ExecutionCheckpointSnapshot {
  const normalized = normalizeSnapshot(snapshot);
  const bounded = normalized.snapshot;
  const categories = normalized.categories;
  for (let level = 0; level <= 4; level += 1) {
    const candidate = { ...bounded, compaction: compactionMetadata(normalized.originalBytes, categories) };
    if (serializedBytes(candidate) <= MAX_EXECUTION_CHECKPOINT_BYTES) return candidate;
    if (level < 4) compactToLevel(bounded, categories, level + 1);
  }
  // All known fields have fixed limits at level four. Keep this defensive
  // branch so malformed future additions cannot reintroduce silent loss or an
  // unbounded persistence write.
  const candidate = { ...bounded, compaction: compactionMetadata(normalized.originalBytes, categories) };
  if (serializedBytes(candidate) <= MAX_EXECUTION_CHECKPOINT_BYTES) return candidate;
  throw new Error(`Execution checkpoint projection exceeds ${MAX_EXECUTION_CHECKPOINT_BYTES} bytes after loss-aware compaction`);
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
