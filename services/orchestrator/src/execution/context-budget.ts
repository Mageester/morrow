import type { ChatMessage, ProviderProtocol, ToolDefinition } from "../provider/base.js";
import { getEncoding } from "js-tiktoken";

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

export interface ProviderRequestEnvelope {
  providerId: string;
  model: string;
  protocol: ProviderProtocol;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  outputReserveTokens: number;
}

export interface ProviderRequestMeasurement {
  inputTokens: number;
  outputReserveTokens: number;
  totalRequestTokens: number;
  method: TokenCountMethod;
  exact: boolean;
  confidence: "exact" | "conservative";
  components: {
    messages: number;
    imageInputs: number;
    toolSchemas: number;
    providerContinuation: number;
    protocolOverhead: number;
  };
}

export type ProviderAdmission =
  | { ok: true; measurement: ProviderRequestMeasurement }
  | { ok: false; reason: "request_too_large"; measurement: ProviderRequestMeasurement; usableInputTokens: number };

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

const PROTOCOL_OVERHEAD: Record<ProviderProtocol, number> = {
  "openai-chat": 12,
  "openai-responses": 16,
  "anthropic-messages": 14,
  "gemini-generate-content": 14,
  mock: 0,
};

function conservativeSerializedTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  // Provider-specific tokenizers differ, but every supported text protocol is
  // ultimately UTF-8 on the wire. One token per byte is a safe upper bound for
  // byte-fallback tokenizers and avoids the Unicode undercount produced by the
  // ordinary prose estimator (notably joined emoji and combining sequences).
  return Math.max(estimateTextTokens(serialized), Buffer.byteLength(serialized, "utf8"));
}

/** Count the complete normalized request envelope. Provider adapters serialize
 * this same information onto the wire; private continuation data is counted but
 * is never returned in diagnostics. */
export function measureProviderRequest(envelope: ProviderRequestEnvelope): ProviderRequestMeasurement {
  const messageCount = countChatTokens(envelope.messages.map(({ providerContinuation: _private, providerContinuationRouteFingerprint: _binding, images: _images, ...message }) => message), {
    providerId: envelope.providerId,
    model: envelope.model,
  });
  const imageBase = envelope.messages.reduce((sum, message) => {
    if (!message.images?.length) return sum;
    return sum + conservativeSerializedTokens(message.images.map((image) => ({ mimeType: image.mimeType, data: image.data })));
  }, 0);
  const continuationBase = envelope.messages.reduce((sum, message) => {
    if (!message.providerContinuation) return sum;
    return sum + conservativeSerializedTokens(message.providerContinuation);
  }, 0);
  const toolBase = conservativeSerializedTokens(envelope.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  })));
  const protocolBase = PROTOCOL_OVERHEAD[envelope.protocol];
  const toolSchemas = toolBase + Math.ceil(toolBase * 0.15);
  const imageInputs = imageBase + Math.ceil(imageBase * 0.15);
  const providerContinuation = continuationBase + Math.ceil(continuationBase * 0.15);
  const protocolOverhead = protocolBase + Math.ceil(protocolBase * 0.15);
  const hasEstimatedExtras = imageBase > 0 || toolBase > 0 || continuationBase > 0 || protocolBase > 0;
  const inputTokens = messageCount.tokens + imageInputs + toolSchemas + providerContinuation + protocolOverhead;
  return {
    inputTokens,
    outputReserveTokens: envelope.outputReserveTokens,
    totalRequestTokens: inputTokens + envelope.outputReserveTokens,
    method: hasEstimatedExtras ? "estimate" : messageCount.method,
    exact: messageCount.exact && !hasEstimatedExtras,
    confidence: hasEstimatedExtras ? "conservative" : messageCount.confidence,
    components: { messages: messageCount.tokens, imageInputs, toolSchemas, providerContinuation, protocolOverhead },
  };
}

export function admitProviderRequest(
  envelope: ProviderRequestEnvelope,
  budget: { usableInputTokens: number },
): ProviderAdmission {
  const measurement = measureProviderRequest(envelope);
  return admitMeasuredProviderRequest(measurement, budget);
}

/** Admission over an already measured wire envelope. Kept separate so
 * provider-reported/reproduction measurements can be evaluated with exactly
 * the same limit and output-reserve rule as locally tokenized requests. */
export function admitMeasuredProviderRequest(
  measurement: ProviderRequestMeasurement,
  budget: { usableInputTokens: number },
): ProviderAdmission {
  if (measurement.inputTokens > budget.usableInputTokens) {
    return { ok: false, reason: "request_too_large", measurement, usableInputTokens: budget.usableInputTokens };
  }
  return { ok: true, measurement };
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
    summary = deterministicSummary(older, 0, older.flat().length - 1);
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
    operations.push(
      {
        type: "context.minimum_viable_context_exceeded",
        payload: { finalTokens: candidateCount.tokens, maxInputTokens: input.maxInputTokens, provider: input.providerId, model: input.model },
      },
    );
    return {
      ok: false,
      reason: "minimum_context_too_large",
      actionableMessage:
        `Context is too large for ${input.providerId}/${input.model} (${candidateCount.tokens} tokens needed, ${input.maxInputTokens} available).\n` +
        "Recovery options:\n" +
        "1. Start a new session to reset conversation history.\n" +
        "2. Use /context to inspect and trim large messages.\n" +
        "3. Switch to a larger-context model with /model.\n" +
        "4. Reduce the number of attached files or narrow tool results.",
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
