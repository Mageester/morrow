import { createHash } from "node:crypto";
import type { ChatMessage } from "../provider/base.js";
import type { ModelBudget } from "../routing/model-budget.js";
import type { ExecutionCheckpointSnapshot } from "../repositories/execution-continuity.js";
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
  thresholdTokens: number;
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
    messages.push({
      role: "assistant",
      content: turn.assistantText,
      ...(turn.toolCalls.length > 0 ? {
        toolCalls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: input.normalizeToolArguments?.(call.name, call.arguments) ?? call.arguments,
          },
        })),
      } : {}),
      ...(turn.providerContinuation ? { providerContinuation: turn.providerContinuation } : {}),
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
        content: input.normalizeToolResult?.(result.toolName, result.result) ?? result.result,
      });
    }
  }
  return messages;
}

export function projectionFingerprint(messages: ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function groupDurableMessages(messages: ChatMessage[]): { system: ChatMessage[]; groups: ChatMessage[][] } {
  const system = messages.filter((message) => message.role === "system");
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
  const publicSnapshot = {
    version: snapshot.version,
    missionContract: {
      originalMission: snapshot.originalMission,
      hardRequirements: snapshot.hardRequirements,
      prohibitedActions: snapshot.prohibitedActions,
      acceptanceCriteria: snapshot.acceptanceCriteria,
    },
    execution: {
      decisions: snapshot.decisions,
      completedWork: snapshot.completedWork,
      currentPhase: snapshot.currentPhase,
      filesChanged: snapshot.filesChanged,
      gitStatus: snapshot.gitStatus,
      tests: snapshot.tests,
      unresolvedFailures: snapshot.unresolvedFailures,
      recoveryAttempts: snapshot.recoveryAttempts,
      pendingWork: snapshot.pendingWork,
      approvals: snapshot.approvals,
      evidenceRequired: snapshot.evidenceRequired,
    },
    identity: { taskId: snapshot.taskId, missionId: snapshot.missionId },
    routing: snapshot.providerRouting,
  };
  return {
    role: "system",
    content: `Morrow durable execution checkpoint. Continue the same mission; this is not a new task and is not completion.\n${JSON.stringify(publicSnapshot)}`,
  };
}

function hashEnvelope(envelope: ProviderRequestEnvelope): string {
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
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
  const thresholdTokens = Math.floor(input.resolution.usableInputTokens * thresholdRatio);
  const originalMeasurement = measureProviderRequest(input.envelope);
  const shouldCompact = input.forceCompaction === true || originalMeasurement.inputTokens >= thresholdTokens;

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
  const recent = groups.slice(-recentRawGroups).flat();
  const messages = [...system, checkpointMessage(input.checkpoint), ...recent];
  const ordering = validateProviderMessageOrdering(messages);
  if (!ordering.ok) {
    throw new Error(`Durable provider projection is invalid: ${ordering.reason} (${ordering.detail})`);
  }
  const envelope = { ...input.envelope, messages };
  const admission = admitProviderRequest(envelope, input.resolution);
  return {
    envelope,
    admission,
    originalMeasurement,
    compacted: true,
    thresholdTokens,
    contentHash: hashEnvelope(envelope),
  };
}
