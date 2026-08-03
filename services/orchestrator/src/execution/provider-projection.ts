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
  status?: "completed" | "failed";
}

const CHECKPOINT_PREFIX = "Morrow durable execution checkpoint.";
const COMPACTED_BATCH_PREFIX = "Morrow compacted the latest completed execution batch";

function isGeneratedProjectionMessage(message: ChatMessage): boolean {
  return message.role === "system"
    && (message.content.startsWith(CHECKPOINT_PREFIX) || message.content.startsWith(COMPACTED_BATCH_PREFIX));
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
      content: redactSecrets(turn.assistantText),
      ...(turn.toolCalls.length > 0 ? {
      toolCalls: turn.toolCalls.map((call) => {
          const observation = results.get(call.id);
          const normalizedArguments = observation?.status === "failed"
            ? call.arguments
            : input.normalizeToolArguments?.(call.name, call.arguments) ?? call.arguments;
          return {
            id: call.id,
            type: "function" as const,
            function: {
              name: call.name,
              // Failed write calls need their original body on the next turn
              // so provider can repair one bad field. Compact only calls whose
              // effect completed durably.
              arguments: redactJsonText(normalizedArguments) ?? redactSecrets(normalizedArguments),
            },
          };
        }),
      } : {}),
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
        content: redactJsonText(input.normalizeToolResult?.(result.toolName, result.result) ?? result.result) ?? redactSecrets(result.result),
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
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
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
  let envelope = { ...input.envelope, messages };
  let admission = admitProviderRequest(envelope, input.resolution);
  // A batch can contain many individually-safe reads/writes. If their combined
  // newest group still cannot fit, compact that completed group too instead of
  // failing after claiming automatic compaction succeeded.
  if (!admission.ok) {
    envelope = { ...input.envelope, messages: [...system, checkpointMessage(input.checkpoint), compactLatestBatch(groups)] };
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
