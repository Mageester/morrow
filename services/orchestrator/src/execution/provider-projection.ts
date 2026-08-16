import { createHash } from "node:crypto";
import type { ChatMessage } from "../provider/base.js";
import type { ModelBudget } from "../routing/model-budget.js";
import type { ExecutionCheckpointSnapshot } from "../repositories/execution-continuity.js";
import { redactJsonText, redactSecrets, redactSecretsDeep } from "../provider/credentials.js";
import {
  admitProviderRequest,
  measureProviderRequest,
  validateProviderMessageOrdering,
  type ProviderAdmission,
  type ProviderRequestEnvelope,
  type ProviderRequestMeasurement,
} from "./context-budget.js";

export interface ProviderProjectionResult {
  envelope: ProviderRequestEnvelope;
  admission: ProviderAdmission;
  originalMeasurement: ProviderRequestMeasurement;
  compacted: boolean;
  thresholdTokens: number | null;
  contentHash: string;
}

export interface DurableProviderTurn {
  turnKey: string;
  assistantText: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  providerContinuation?: ChatMessage["providerContinuation"];
  providerContinuationRouteFingerprint?: string;
}

export interface DurableToolObservation {
  id: string;
  toolName: string;
  result: string;
  status?: "completed" | "failed";
}

const CHECKPOINT_PREFIX = "Morrow durable execution checkpoint.";
const COMPACTED_BATCH_PREFIX = "Morrow compacted the latest completed execution batch";
const HISTORICAL_ARGUMENT_BYTE_LIMIT = 8 * 1024;

/**
 * Bound a successful workspace-write argument for a provider request without
 * inventing an executable payload. The complete arguments remain in the
 * durable provider-turn row; this projection keeps the tool identity and
 * useful target metadata while making the large body unavailable to replay.
 *
 * The legacy `_morrowAppliedWrite` shape is accepted only as old input. It is
 * converted to the same non-executable metadata shape and is never emitted by
 * the current projection.
 */
export function boundCompletedToolArguments(toolName: string, rawArguments: string): string {
  const originalBytes = Buffer.byteLength(rawArguments, "utf8");
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(rawArguments) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return rawArguments;
    parsed = value as Record<string, unknown>;
  } catch {
    return originalBytes <= HISTORICAL_ARGUMENT_BYTE_LIMIT
      ? rawArguments
      : JSON.stringify({ durable_context: { kind: "completed_tool_arguments", tool: toolName, originalBytes } });
  }

  const legacyMarker = parsed._morrowAppliedWrite;
  if (legacyMarker && typeof legacyMarker === "object") {
    const { _morrowAppliedWrite: _legacy, content: _content, patch: _patch, ...rest } = parsed;
    return JSON.stringify({
      ...rest,
      durable_context: {
        kind: "legacy_applied_write",
        tool: toolName,
        ...(typeof legacyMarker === "object" ? legacyMarker : {}),
      },
    });
  }
  if (originalBytes <= HISTORICAL_ARGUMENT_BYTE_LIMIT) return rawArguments;

  const bodyKey = toolName === "propose_patch" ? "patch" : toolName === "create_file" || toolName === "append_file" ? "content" : null;
  const body = bodyKey ? parsed[bodyKey] : undefined;
  if (typeof body !== "string") {
    return JSON.stringify({ durable_context: { kind: "completed_tool_arguments", tool: toolName, originalBytes } });
  }
  const { [bodyKey!]: _body, ...rest } = parsed;
  return JSON.stringify({
    ...rest,
    durable_context: {
      kind: "completed_tool_arguments",
      tool: toolName,
      originalBytes,
      payloadBytes: Buffer.byteLength(body, "utf8"),
      payloadSha256: createHash("sha256").update(body).digest("hex"),
      note: "Complete successful arguments remain in durable execution history; inspect the workspace for current content.",
    },
  });
}

/**
 * Bound any terminal historical call, including a failed write. Failed calls
 * still keep their raw operator result/status, but an oversized request body
 * is not useful as replay context: retain the target and a durable digest so
 * the model can choose a repair without re-injecting an executable payload.
 */
export function boundTerminalToolArguments(
  toolName: string,
  rawArguments: string,
  status: "completed" | "failed" = "completed",
): string {
  if (status === "completed") return boundCompletedToolArguments(toolName, rawArguments);
  const originalBytes = Buffer.byteLength(rawArguments, "utf8");
  if (originalBytes <= HISTORICAL_ARGUMENT_BYTE_LIMIT) return rawArguments;
  try {
    const value = JSON.parse(rawArguments) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return JSON.stringify({ durable_context: { kind: "failed_tool_arguments", tool: toolName, originalBytes } });
    }
    const parsed = value as Record<string, unknown>;
    const targetKeys = ["path", "paths", "query", "pattern", "executable", "cwd", "purpose", "expectedOffset", "files"];
    const target = Object.fromEntries(targetKeys.flatMap((key) => key in parsed ? [[key, parsed[key]]] : []));
    const payloadKey = toolName === "propose_patch"
      ? "patch"
      : toolName === "create_file" || toolName === "append_file"
        ? "content"
        : undefined;
    const payload = payloadKey && typeof parsed[payloadKey] === "string" ? parsed[payloadKey] as string : undefined;
    return JSON.stringify({
      ...target,
      durable_context: {
        kind: "failed_tool_arguments",
        tool: toolName,
        originalBytes,
        ...(payload ? {
          payloadBytes: Buffer.byteLength(payload, "utf8"),
          payloadSha256: createHash("sha256").update(payload).digest("hex"),
        } : {}),
        note: "The complete failed arguments remain in durable operator history; repair the target using current workspace evidence.",
      },
    });
  } catch {
    return JSON.stringify({ durable_context: { kind: "failed_tool_arguments", tool: toolName, originalBytes } });
  }
}

/** Keep direct projection callers bounded even when they have not first run
 * the repository's lazy externalization repair. Normal execution persists an
 * artifact reference before reaching this fallback. */
export function boundTerminalToolResult(toolName: string, result: string): string {
  if (Buffer.byteLength(result, "utf8") <= HISTORICAL_ARGUMENT_BYTE_LIMIT) return result;
  try {
    const parsed = JSON.parse(result) as unknown;
    const metadata: Record<string, unknown> = { truncatedForContext: true, tool: toolName, originalBytes: Buffer.byteLength(result, "utf8") };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of ["error", "kind", "detail", "message", "exitCode", "durationMs", "terminationReason", "status"]) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string" || typeof value === "number") metadata[key] = value;
      }
    }
    return JSON.stringify(metadata);
  } catch {
    return JSON.stringify({ truncatedForContext: true, tool: toolName, originalBytes: Buffer.byteLength(result, "utf8") });
  }
}

function isGeneratedProjectionMessage(message: ChatMessage): boolean {
  return message.role === "system"
    && (message.content.startsWith(CHECKPOINT_PREFIX)
      || message.content.startsWith(COMPACTED_BATCH_PREFIX));
}

/**
 * Canonical reconstruction from append-only durable turns and tool results.
 * The cumulative presentation message is deliberately not an input. Duplicate
 * tool references resolve to one observation, so projection growth is linear.
 */
export function buildProviderProjection(input: {
  prefixMessages: ChatMessage[];
  turns: DurableProviderTurn[];
  toolResults: DurableToolObservation[];
  normalizeToolArguments?: (toolName: string, argumentsJson: string) => string;
  normalizeToolResult?: (toolName: string, result: string) => string;
}): ChatMessage[] {
  const messages = input.prefixMessages.map((message) => structuredClone(message));
  const results = new Map(input.toolResults.map((result) => [result.id, result]));
  const projectedResults = new Set<string>();
  for (const turn of input.turns) {
    const toolCalls = turn.toolCalls.flatMap((call) => {
      const observation = results.get(call.id);
      // A successful write is still a provider-visible assistant tool request,
      // but its large body is a context-only historical projection. Failed
      // calls retain their original body so the provider can repair them.
      const isWorkspaceMutation = call.name === "create_file"
        || call.name === "append_file"
        || call.name === "propose_patch";
      const normalizedArguments = isWorkspaceMutation
        ? observation?.status === "failed"
          ? call.arguments
          : boundCompletedToolArguments(call.name, call.arguments)
        : input.normalizeToolArguments?.(call.name, call.arguments) ?? call.arguments;
      const projectedArguments = observation?.status
        ? boundTerminalToolArguments(call.name, normalizedArguments, observation.status)
        : normalizedArguments.includes("_morrowAppliedWrite")
          ? boundCompletedToolArguments(call.name, call.arguments)
          : normalizedArguments;
      return [{
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          // Failed write calls need their original body on the next turn
          // so provider can repair one bad field. Compact only calls whose
          // effect completed durably.
          arguments: redactJsonText(projectedArguments) ?? redactSecrets(projectedArguments),
        },
      }];
    });
    messages.push({
      role: "assistant",
      content: redactSecrets(turn.assistantText),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(turn.providerContinuation ? { providerContinuation: redactSecretsDeep(turn.providerContinuation) } : {}),
      ...(turn.providerContinuationRouteFingerprint ? { providerContinuationRouteFingerprint: turn.providerContinuationRouteFingerprint } : {}),
    });
    for (const call of turn.toolCalls) {
      if (projectedResults.has(call.id)) continue;
      const result = results.get(call.id);
      if (!result) continue;
      projectedResults.add(call.id);
      messages.push({
        role: "tool",
        name: result.toolName,
        toolCallId: result.id,
        content: boundTerminalToolResult(
          result.toolName,
          redactJsonText(input.normalizeToolResult?.(result.toolName, result.result) ?? result.result) ?? redactSecrets(result.result),
        ),
      });
    }
  }
  return messages;
}

export function projectionFingerprint(messages: ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function groupDurableMessages(messages: ChatMessage[]): { system: ChatMessage[]; groups: ChatMessage[][] } {
  // Projection output can become next segment's input. Replace old generated
  // checkpoint/batch messages instead of preserving and stacking them forever.
  const system = messages.filter((message) => message.role === "system" && !isGeneratedProjectionMessage(message));
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool" && groups.length > 0) groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  return { system, groups };
}

/** Serialize only mission-owned checkpoint state. Provider continuation row IDs
 * and provider-owned opaque values are deliberately excluded from projection. */
function checkpointMessage(snapshot: ExecutionCheckpointSnapshot): ChatMessage {
  const boundedList = (values: string[], limit: number, itemLimit = 300): string[] =>
    values.slice(-limit).map((value) => value.slice(0, itemLimit));
  const boundedGitStatus = snapshot.gitStatus.split(/\r?\n/).slice(-40).join("\n").slice(0, 2_000);
  const publicSnapshot = {
    version: snapshot.version,
    missionContract: {
      originalMission: snapshot.originalMission.slice(0, 4_000),
      hardRequirements: boundedList(snapshot.hardRequirements, 30),
      prohibitedActions: boundedList(snapshot.prohibitedActions, 30),
      acceptanceCriteria: boundedList(snapshot.acceptanceCriteria, 30),
    },
    execution: {
      decisions: boundedList(snapshot.decisions, 20),
      completedWork: boundedList(snapshot.completedWork, 20),
      currentPhase: snapshot.currentPhase,
      filesChanged: boundedList(snapshot.filesChanged, 20, 200),
      gitStatus: boundedGitStatus,
      tests: snapshot.tests.slice(-10).map((test) => ({ ...test, command: test.command.slice(0, 200), result: test.result.slice(0, 500) })),
      unresolvedFailures: boundedList(snapshot.unresolvedFailures, 10, 500),
      recoveryAttempts: boundedList(snapshot.recoveryAttempts, 10, 500),
      pendingWork: boundedList(snapshot.pendingWork, 20),
      approvals: snapshot.approvals,
      evidenceRequired: boundedList(snapshot.evidenceRequired, 30),
      // Live task-owned resources. Without these the model loses the handle to
      // a server it started and cannot stop it before finishing.
      ...(snapshot.runningProcesses && snapshot.runningProcesses.length > 0
        ? {
            runningProcesses: snapshot.runningProcesses.slice(-10).map((item) => ({
              processId: item.processId.slice(0, 100),
              command: item.command.slice(0, 300),
            })),
          }
        : {}),
    },
    identity: { taskId: snapshot.taskId, missionId: snapshot.missionId },
    routing: snapshot.providerRouting,
  };
  return {
    role: "system",
    content: `${CHECKPOINT_PREFIX} Continue the same mission; this is not a new task and is not completion.\n${JSON.stringify(publicSnapshot)}`,
  };
}

function hashEnvelope(envelope: ProviderRequestEnvelope): string {
  return measureProviderRequest(envelope).canonicalRequestHash
    ?? createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

/** Last tool batch may itself be wider than a provider's usable input. Keep
 * durable checkpoint state plus a terse operation ledger, never raw arguments
 * or observations. The original turns and artifacts remain available locally. */
function compactLatestBatch(groups: ChatMessage[][]): ChatMessage {
  const latest = groups.at(-1) ?? [];
  const entries = latest.map((message) => {
    if (message.role === "tool") return `- ${message.name ?? "tool"}: completed`;
    if (message.role === "assistant" && message.toolCalls?.length) {
      return `- assistant called: ${message.toolCalls.map((call) => call.function.name).join(", ")}`;
    }
    const text = message.content.replace(/\s+/g, " ").slice(0, 1_200);
    return `- ${message.role}: ${text || "completed"}`;
  });
  return {
    role: "system",
    content: `${COMPACTED_BATCH_PREFIX} to fit this route. Full tool records remain durable; continue from checkpoint and inspect narrowly if needed.\n${entries.join("\n")}`,
  };
}

const COMPACTED_USER_QUERY_CHAR_LIMIT = 4_000;

function compactUserQuery(message: ChatMessage): ChatMessage {
  if (message.role !== "user" || message.content.length <= COMPACTED_USER_QUERY_CHAR_LIMIT) return message;
  const normalized = message.content.replace(/\s+/g, " ").trim();
  const words = normalized.split(" ").filter(Boolean);
  const distinctWordRatio = words.length === 0 ? 1 : new Set(words.map((word) => word.toLowerCase())).size / words.length;
  const excerpt = distinctWordRatio < 0.2
    ? "The full user request is retained in Morrow's durable checkpoint; continue from that checkpoint."
    : `${normalized.slice(0, 1_800)}\n[User request compacted for this provider route; the full request remains durable in Morrow.]\n${normalized.slice(-1_800)}`;
  return { ...message, content: excerpt };
}

const PRESSURE_TOOL_PRIORITY = [
  "read_file",
  "search_text",
  "list_files",
  "run_command",
  "create_file",
  "propose_patch",
  "git_status",
  "git_diff",
  "read_process_output",
  "stop_process",
] as const;

function pressureToolSets(envelope: ProviderRequestEnvelope, groups: ChatMessage[][]): ProviderRequestEnvelope["tools"][] {
  const recentNames = groups.slice(-1).flat().flatMap((message) => message.toolCalls?.map((call) => call.function.name) ?? []);
  const priority = [...new Set([...recentNames, ...PRESSURE_TOOL_PRIORITY])];
  const byName = new Map(envelope.tools.map((tool) => [tool.name, tool]));
  const ordered = priority.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [tool] : [];
  });
  return [12, 8, 5, 0].map((limit) => ordered.slice(0, limit));
}

/**
 * Apply the one route-aware admission rule to a complete provider envelope.
 * Once the configurable pressure threshold is reached, replace old raw history
 * with the structured checkpoint plus whole recent turn groups, then remeasure.
 * The function is pure so rebuilding unchanged durable state is byte-idempotent.
 */
export function projectProviderRequest(input: {
  checkpoint: ExecutionCheckpointSnapshot;
  envelope: ProviderRequestEnvelope;
  resolution: ModelBudget;
  thresholdRatio?: number;
  recentRawGroups?: number;
  forceCompaction?: boolean;
}): ProviderProjectionResult {
  const thresholdRatio = input.thresholdRatio ?? 0.8;
  if (!(thresholdRatio > 0 && thresholdRatio <= 1)) throw new Error("Context compaction threshold must be in (0, 1]");
  const thresholdTokens = input.resolution.usableInputTokens !== null && input.resolution.usableInputTokens !== undefined
    ? Math.floor(input.resolution.usableInputTokens * thresholdRatio)
    : null;
  const originalMeasurement = measureProviderRequest(input.envelope);
  const shouldCompact = input.forceCompaction === true || (thresholdTokens !== null && originalMeasurement.inputTokens >= thresholdTokens);

  if (!shouldCompact) {
    const admission = admitProviderRequest(input.envelope, input.resolution);
    return {
      envelope: input.envelope,
      admission,
      originalMeasurement,
      compacted: false,
      thresholdTokens,
      contentHash: hashEnvelope(input.envelope),
    };
  }

  const { system, groups } = groupDurableMessages(input.envelope.messages);
  const recentRawGroups = Math.max(1, input.recentRawGroups ?? 2);
  // A provider request must retain the active user query even when the latest
  // raw group is an assistant/tool batch. Otherwise a valid execution history
  // compacts to system-only instructions plus tool history, which providers
  // such as TokenRouter reject as "No user query found in messages.".
  const recentStart = Math.max(0, groups.length - recentRawGroups);
  let latestUserGroup = -1;
  for (let index = groups.length - 1; index >= 0; index--) {
    if (groups[index]!.some((message) => message.role === "user")) {
      latestUserGroup = index;
      break;
    }
  }
  const preservedStart = latestUserGroup >= 0 ? Math.min(recentStart, latestUserGroup) : recentStart;
  const recent = groups.slice(preservedStart).flat().map(compactUserQuery);
  const messages = [...system, checkpointMessage(input.checkpoint), ...recent];
  const ordering = validateProviderMessageOrdering(messages);
  if (!ordering.ok) {
    throw new Error(`Durable provider projection is invalid: ${ordering.reason} (${ordering.detail})`);
  }
  let envelope = { ...input.envelope, messages };
  let admission = admitProviderRequest(envelope, input.resolution);
  // A batch can contain many individually-safe reads/writes. Leave the same
  // headroom that triggered compaction instead of merely fitting the hard
  // route limit; otherwise the accepted projection is guaranteed to compact
  // again on the very next turn.
  if (!admission.ok || (thresholdTokens !== null && admission.measurement.inputTokens >= thresholdTokens)) {
    const compactibleGroups = latestUserGroup >= 0
      ? groups.filter((_group, index) => index !== latestUserGroup)
      : groups;
    const compactedBatch = compactibleGroups.length > 0 ? compactLatestBatch(compactibleGroups) : undefined;
    const preservedUser = latestUserGroup >= 0
      ? groups[latestUserGroup]!.map(compactUserQuery)
      : [];
    envelope = {
      ...input.envelope,
      messages: [
        ...system,
        checkpointMessage(input.checkpoint),
        ...(compactedBatch ? [compactedBatch] : []),
        ...preservedUser,
      ],
    };
    admission = admitProviderRequest(envelope, input.resolution);
  }
  // Tool schemas are part of the wire request. Small routes cannot carry every
  // optional tool plus checkpoint state indefinitely. Reduce to a deterministic
  // coding core, remeasure each set, and send exactly the measured set.
  if (!admission.ok && envelope.tools.length > 0) {
    for (const tools of pressureToolSets(envelope, groups)) {
      const candidate = { ...envelope, tools };
      const candidateAdmission = admitProviderRequest(candidate, input.resolution);
      envelope = candidate;
      admission = candidateAdmission;
      if (candidateAdmission.ok) break;
    }
  }
  return {
    envelope,
    admission,
    originalMeasurement,
    compacted: true,
    thresholdTokens,
    contentHash: hashEnvelope(envelope),
  };
}
