import type { ChatMessage } from "../provider/base.js";
import { getEncoding } from "js-tiktoken";
import { getModel } from "../routing/models.js";

export interface ContextBudget {
  maxInputTokens: number;
}

export interface ContextTrimResult {
  messages: ChatMessage[];
  originalTokens: number;
  finalTokens: number;
  trimmedMessages: number;
}

export type TokenCountMethod = "exact" | "estimate";
export type ContextWindowSource = "known-model" | "user-config" | "fallback";

export interface TokenCountResult {
  tokens: number;
  method: TokenCountMethod;
  exact: boolean;
  tokenizer: string;
  providerId: string;
  model: string;
  confidence: "exact" | "conservative";
  marginTokens: number;
}

export interface ResolvedContextBudget {
  providerId: string;
  model: string;
  contextWindowTokens: number;
  contextWindowSource: ContextWindowSource;
  exactModelLimit: boolean;
  outputBudgetTokens: number;
  reservedTokens: number;
  maxInputTokens: number;
  safetyMarginTokens: number;
}

export interface ContextOperation {
  type:
    | "context.budget_calculated"
    | "context.estimate_used"
    | "context.exact_count_used"
    | "context.compaction_completed"
    | "context.history_trimmed"
    | "context.safety_fallback_applied"
    | "context.minimum_viable_context_exceeded";
  payload: Record<string, unknown>;
}

export interface ContextSummary {
  method: "deterministic" | "fallback";
  content: string;
  sourceStartIndex: number;
  sourceEndIndex: number;
  sourceMessageCount: number;
}

export type ContextPrepareResult =
  | {
      ok: true;
      messages: ChatMessage[];
      tokenCount: TokenCountResult;
      finalTokens: number;
      removedGroups: number;
      compactedGroups: number;
      summary?: ContextSummary;
      operations: ContextOperation[];
    }
  | {
      ok: false;
      reason: "minimum_context_too_large" | "invalid_message_ordering";
      actionableMessage: string;
      tokenCount: TokenCountResult;
      operations: ContextOperation[];
    };

const DEFAULT_FALLBACK_CONTEXT_WINDOW = 32768;

let openAiEncoding: ReturnType<typeof getEncoding> | undefined;

function getOpenAiEncoding(): ReturnType<typeof getEncoding> {
  openAiEncoding ??= getEncoding("o200k_base");
  return openAiEncoding;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const lexical = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)?.length ?? 0;
  const byteEstimate = Math.ceil(Buffer.byteLength(text, "utf8") / 4);
  return Math.max(1, lexical, byteEstimate);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = 4 + estimateTextTokens(message.content);
  if (message.name) total += estimateTextTokens(message.name);
  if (message.toolCallId) total += estimateTextTokens(message.toolCallId);
  for (const toolCall of message.toolCalls ?? []) {
    total += 8;
    total += estimateTextTokens(toolCall.id);
    total += estimateTextTokens(toolCall.function.name);
    total += estimateTextTokens(toolCall.function.arguments);
  }
  return total;
}

export function estimateChatTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 3);
}

function supportsExactOpenAiTokenizer(providerId: string, model: string): boolean {
  return ["openai", "openrouter", "openai-compatible"].includes(providerId) && /(?:^|\/)(?:gpt-|o\d|chatgpt)/i.test(model);
}

function serializeForCounting(message: ChatMessage): string {
  const toolCalls = (message.toolCalls ?? []).map((call) => `${call.id}:${call.function.name}:${call.function.arguments}`).join("\n");
  return [message.role, message.name, message.toolCallId, message.content, toolCalls].filter(Boolean).join("\n");
}

export function countChatTokens(messages: ChatMessage[], input: { providerId: string; model: string }): TokenCountResult {
  if (supportsExactOpenAiTokenizer(input.providerId, input.model)) {
    const enc = getOpenAiEncoding();
    let tokens = 3;
    for (const message of messages) tokens += 4 + enc.encode(serializeForCounting(message)).length;
    return {
      tokens,
      method: "exact",
      exact: true,
      tokenizer: "tiktoken:o200k_base",
      providerId: input.providerId,
      model: input.model,
      confidence: "exact",
      marginTokens: 0,
    };
  }
  const tokens = estimateChatTokens(messages);
  const marginTokens = Math.ceil(tokens * 0.15);
  return {
    tokens: tokens + marginTokens,
    method: "estimate",
    exact: false,
    tokenizer: "morrow:deterministic-estimator",
    providerId: input.providerId,
    model: input.model,
    confidence: "conservative",
    marginTokens,
  };
}

export function inputTokenBudget(input: {
  contextBudgetBytes: number;
  modelContextWindow?: number | null;
  outputBudgetTokens?: number | null;
  reserveTokens?: number;
}): number {
  const presetBudget = Math.max(1, Math.floor(input.contextBudgetBytes / 4));
  const reserve = input.reserveTokens ?? 1024;
  if (!input.modelContextWindow) return presetBudget;
  const modelInputBudget = Math.max(1, input.modelContextWindow - (input.outputBudgetTokens ?? 0) - reserve);
  return Math.min(presetBudget, modelInputBudget);
}

export function resolveContextBudget(input: {
  providerId: string;
  model: string;
  presetContextBudgetBytes: number;
  outputBudgetTokens?: number | null;
  userContextWindowTokens?: number | null;
  toolCount?: number;
  safetyMarginTokens?: number;
}): ResolvedContextBudget {
  const knownWindow = getModel(input.model)?.contextWindow ?? null;
  const contextWindowTokens = input.userContextWindowTokens ?? knownWindow ?? DEFAULT_FALLBACK_CONTEXT_WINDOW;
  const contextWindowSource: ContextWindowSource = input.userContextWindowTokens ? "user-config" : knownWindow ? "known-model" : "fallback";
  const outputBudgetTokens = input.outputBudgetTokens ?? 2048;
  const safetyMarginTokens = input.safetyMarginTokens ?? Math.max(512, Math.ceil(contextWindowTokens * 0.02));
  const toolReserve = (input.toolCount ?? 0) * 256;
  const framingReserve = 512;
  const reservedTokens = outputBudgetTokens + safetyMarginTokens + toolReserve + framingReserve;
  const presetBudget = Math.max(1, Math.floor(input.presetContextBudgetBytes / 4));
  const windowBudget = Math.max(1, contextWindowTokens - reservedTokens);
  return {
    providerId: input.providerId,
    model: input.model,
    contextWindowTokens,
    contextWindowSource,
    exactModelLimit: contextWindowSource !== "fallback",
    outputBudgetTokens,
    reservedTokens,
    maxInputTokens: Math.max(1, Math.min(presetBudget, windowBudget)),
    safetyMarginTokens,
  };
}

function groupMessages(messages: ChatMessage[]): { mandatory: ChatMessage[]; groups: ChatMessage[][] } {
  const mandatory = messages.filter((message) => message.role === "system");
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool" && groups.length > 0) groups[groups.length - 1]!.push(message);
    else groups.push([message]);
  }
  return { mandatory, groups };
}

export function validateProviderMessageOrdering(messages: ChatMessage[]): { ok: true } | { ok: false; reason: "orphan_tool_result" | "unresolved_tool_call"; detail: string } {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallId || !pending.has(message.toolCallId)) {
        return { ok: false, reason: "orphan_tool_result", detail: message.toolCallId ?? "missing tool_call_id" };
      }
      pending.delete(message.toolCallId);
      continue;
    }
    if (pending.size > 0) {
      return { ok: false, reason: "unresolved_tool_call", detail: [...pending].join(",") };
    }
    for (const call of message.toolCalls ?? []) pending.add(call.id);
  }
  if (pending.size > 0) return { ok: false, reason: "unresolved_tool_call", detail: [...pending].join(",") };
  return { ok: true };
}

function redactContextSummary(text: string): string {
  return text
    .replace(/\b(api[_-]?key|token|secret|password|authorization|credential)\b\s*([=:])\s*(['"]?)[^\s'"`]+/gi, "$1$2[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]");
}

function deterministicSummary(groups: ChatMessage[][], startIndex: number, endIndex: number): ContextSummary | undefined {
  if (groups.length === 0) return undefined;
  const raw = groups.flat().map((message) => message.content).join("\n");
  const redacted = redactContextSummary(raw);
  const concise = (value: string, limit = 200) =>
    value
      .replace(/\b([\p{L}\p{N}_-]+)(?:\s+\1\b){2,}/giu, "$1 ...")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  const paths = [...new Set(redacted.match(/[\w./\\-]+\.(?:ts|tsx|js|jsx|json|md|css|html|py|go|rs)/g) ?? [])].slice(0, 12);
  const commands = [...new Set(redacted.match(/\b(?:pnpm|npm|yarn|node|git|pytest|cargo|go test|tsc)\b[^\n.]*/gi) ?? [])].slice(0, 8);
  const errors = [...new Set(redacted.match(/\b(?:error|failed|failure|exception)\b[^\n.]*/gi) ?? [])].slice(0, 8);
  const decisions = redacted
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /\b(goal|decision|constraint|todo|unresolved|completed|keep|must|should)\b/i.test(line))
    .slice(0, 10);
  const lines = [
    "Context summary (deterministic, compacted from earlier conversation):",
    ...(decisions.length ? ["Decisions/goals:", ...decisions.map((line) => `- ${concise(line, 240)}`)] : []),
    ...(paths.length ? ["Files:", ...paths.map((path) => `- ${path}`)] : []),
    ...(commands.length ? ["Commands:", ...commands.map((command) => `- ${concise(command)}`)] : []),
    ...(errors.length ? ["Errors:", ...errors.map((error) => `- ${concise(error)}`)] : []),
  ];
  if (lines.length === 1) lines.push(redacted.replace(/\s+/g, " ").slice(0, 800));
  return {
    method: "deterministic",
    content: lines.join("\n"),
    sourceStartIndex: startIndex,
    sourceEndIndex: endIndex,
    sourceMessageCount: groups.flat().length,
  };
}

function asSystemSummary(summary: ContextSummary): ChatMessage {
  return { role: "system", content: summary.content };
}

export function trimMessagesToBudget(messages: ChatMessage[], budget: ContextBudget): ContextTrimResult {
  const originalTokens = estimateChatTokens(messages);
  if (originalTokens <= budget.maxInputTokens) {
    return { messages, originalTokens, finalTokens: originalTokens, trimmedMessages: 0 };
  }

  const { mandatory: systemMessages, groups: nonSystemSegments } = groupMessages(messages);

  const keptSegments: ChatMessage[][] = [];
  for (let i = nonSystemSegments.length - 1; i >= 0; i--) {
    const candidate = [...systemMessages, ...nonSystemSegments.slice(i).flat()];
    if (estimateChatTokens(candidate) <= budget.maxInputTokens) {
      keptSegments.unshift(nonSystemSegments[i]!);
    } else if (keptSegments.length === 0) {
      keptSegments.unshift(nonSystemSegments[i]!);
      break;
    } else {
      break;
    }
  }

  const trimmed = [...systemMessages, ...keptSegments.flat()];
  return {
    messages: trimmed,
    originalTokens,
    finalTokens: estimateChatTokens(trimmed),
    trimmedMessages: messages.length - trimmed.length,
  };
}

export function prepareContextForProvider(
  messages: ChatMessage[],
  input: {
    providerId: string;
    model: string;
    maxInputTokens: number;
    compact?: boolean;
    recentRawGroups?: number;
  }
): ContextPrepareResult {
  const operations: ContextOperation[] = [];
  const count = (candidate: ChatMessage[]) => countChatTokens(candidate, { providerId: input.providerId, model: input.model });
  const firstCount = count(messages);
  operations.push({
    type: firstCount.exact ? "context.exact_count_used" : "context.estimate_used",
    payload: { provider: input.providerId, model: input.model, tokens: firstCount.tokens, method: firstCount.method, exact: firstCount.exact },
  });
  if (firstCount.tokens <= input.maxInputTokens) {
    const ordering = validateProviderMessageOrdering(messages);
    if (!ordering.ok) {
      return {
        ok: false,
        reason: "invalid_message_ordering",
        actionableMessage: `Context message ordering is invalid: ${ordering.reason}. Start a new session or retry after the interrupted tool call is resolved.`,
        tokenCount: firstCount,
        operations,
      };
    }
    return { ok: true, messages, tokenCount: firstCount, finalTokens: firstCount.tokens, removedGroups: 0, compactedGroups: 0, operations };
  }

  const { mandatory, groups } = groupMessages(messages);
  const recentRawGroups = Math.max(1, input.recentRawGroups ?? 2);
  const recent = groups.slice(-recentRawGroups);
  const older = groups.slice(0, Math.max(0, groups.length - recentRawGroups));
  let summary: ContextSummary | undefined;
  let candidate = [...mandatory, ...recent.flat()];

  if (input.compact && older.length > 0) {
    summary = deterministicSummary(older, 0, older.length - 1);
    if (summary) {
      candidate = [...mandatory, asSystemSummary(summary), ...recent.flat()];
      operations.push({
        type: "context.compaction_completed",
        payload: { method: summary.method, compactedGroups: older.length, sourceMessageCount: summary.sourceMessageCount },
      });
    }
  }

  let candidateCount = count(candidate);
  if (candidateCount.tokens > input.maxInputTokens && summary) {
    operations.push({ type: "context.safety_fallback_applied", payload: { reason: "summary_too_large" } });
    candidate = [...mandatory, ...recent.flat()];
    candidateCount = count(candidate);
  }

  if (candidateCount.tokens > input.maxInputTokens) {
    operations.push({
      type: "context.minimum_viable_context_exceeded",
      payload: { finalTokens: candidateCount.tokens, maxInputTokens: input.maxInputTokens, provider: input.providerId, model: input.model },
    });
    return {
      ok: false,
      reason: "minimum_context_too_large",
      actionableMessage: `Minimum viable context is too large for ${input.providerId}/${input.model}. Select a larger-context model, start a new session, compact history, or reduce attached content.`,
      tokenCount: candidateCount,
      operations,
    };
  }

  const ordering = validateProviderMessageOrdering(candidate);
  if (!ordering.ok) {
    return {
      ok: false,
      reason: "invalid_message_ordering",
      actionableMessage: `Context message ordering is invalid: ${ordering.reason}. Start a new session or retry after the interrupted tool call is resolved.`,
      tokenCount: candidateCount,
      operations,
    };
  }

  const removedGroups = Math.max(0, groups.length - recent.length - (summary ? older.length : 0));
  if (removedGroups > 0 || firstCount.tokens !== candidateCount.tokens) {
    operations.push({
      type: "context.history_trimmed",
      payload: { inputTokensBefore: firstCount.tokens, inputTokensAfter: candidateCount.tokens, removedGroups, compactedGroups: summary ? older.length : 0 },
    });
  }
  return {
    ok: true,
    messages: candidate,
    tokenCount: candidateCount,
    finalTokens: candidateCount.tokens,
    removedGroups,
    compactedGroups: summary ? older.length : 0,
    ...(summary ? { summary } : {}),
    operations,
  };
}
