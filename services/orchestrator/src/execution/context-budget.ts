import type { ChatMessage, ProviderProtocol, ToolDefinition } from "../provider/base.js";
import { buildCanonicalProviderRequest, type CanonicalVisibleContext } from "./canonical-request.js";
import type { ExactProviderRoute } from "../provider/model-capabilities.js";
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
  /** Exact route identity used for canonical hashing when available. */
  route?: ExactProviderRoute;
  /** Safe model-visible component facts used for explainable accounting. */
  visibleContext?: CanonicalVisibleContext;
}

export interface ProviderRequestMeasurement {
  inputTokens: number;
  outputReserveTokens: number;
  totalRequestTokens: number;
  method: TokenCountMethod;
  exact: boolean;
  confidence: "exact" | "conservative";
  /** The model-visible token total, kept distinct from any response usage. */
  modelVisibleTokens?: number;
  /** Identity of this exact request: model-visible content bound to one route. */
  canonicalRequestHash?: string;
  /** Route-free identity of the model-visible content alone. */
  canonicalContentHash?: string;
  provenance?: {
    routeFingerprint: string;
    canonicalRequestHash: string;
    canonicalContentHash: string;
    method: TokenCountMethod;
    confidence: "exact" | "conservative";
  };
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

/**
 * Per-message token memo.
 *
 * Counting is the hottest pure computation in a turn: a single provider
 * projection measures the same history three times (original measurement,
 * admission, envelope hash), compaction re-measures every candidate, and
 * trimming walks suffixes. Tokenizing a 300-message context costs ~26ms, so an
 * unmemoized turn burned ~85ms of CPU re-deriving numbers that had not changed.
 *
 * The memo is keyed by message identity but VALIDATED by the exact fields the
 * counters read, because the agent rewrites message bodies in place (completed
 * write payloads are replaced with markers). A stale count would silently
 * mis-budget the context, so an entry is reused only when every counted field
 * still compares equal — string comparison is ~100x cheaper than tokenizing and
 * short-circuits on the interned/identical references that dominate in
 * practice. Entries live and die with their message via WeakMap.
 */
interface MessageTokenMemo {
  content: string;
  name: string | undefined;
  toolCallId: string | undefined;
  toolCallsKey: string;
  exact?: number;
  estimate?: number;
}

const messageTokenMemo = new WeakMap<ChatMessage, MessageTokenMemo>();

function toolCallsKey(message: ChatMessage): string {
  const calls = message.toolCalls;
  if (!calls || calls.length === 0) return "";
  return calls.map((call) => `${call.id}:${call.function.name}:${call.function.arguments}`).join("\n");
}

function messageMemo(message: ChatMessage): MessageTokenMemo {
  const key = toolCallsKey(message);
  const existing = messageTokenMemo.get(message);
  if (
    existing
    && existing.content === message.content
    && existing.name === message.name
    && existing.toolCallId === message.toolCallId
    && existing.toolCallsKey === key
  ) {
    return existing;
  }
  const memo: MessageTokenMemo = { content: message.content, name: message.name, toolCallId: message.toolCallId, toolCallsKey: key };
  messageTokenMemo.set(message, memo);
  return memo;
}

function memoizedEstimateMessageTokens(message: ChatMessage): number {
  const memo = messageMemo(message);
  memo.estimate ??= estimateMessageTokens(message);
  return memo.estimate;
}

function memoizedExactMessageTokens(message: ChatMessage, encode: (text: string) => number): number {
  const memo = messageMemo(message);
  memo.exact ??= encode(serializeForCounting(message));
  return memo.exact;
}

export function estimateChatTokens(messages: ChatMessage[]): number {
  let total = 3;
  for (const message of messages) total += memoizedEstimateMessageTokens(message);
  return total;
}

/** Provider ids whose models can be counted with the exact OpenAI tokenizer. */
export const EXACT_TOKENIZER_PROVIDER_IDS = ["openai", "openrouter", "openai-compatible"] as const;

function supportsExactOpenAiTokenizer(providerId: string, model: string): boolean {
  return (EXACT_TOKENIZER_PROVIDER_IDS as readonly string[]).includes(providerId) && /(?:^|\/)(?:gpt-|o\d|chatgpt)/i.test(model);
}

/**
 * Build the exact tokenizer now instead of on the first turn that needs it.
 *
 * `getEncoding("o200k_base")` decodes and indexes the full rank table: ~350ms
 * of synchronous CPU and ~66MB of heap. Paid lazily it lands squarely inside
 * the user's first request; paid at boot it lands while the process is idle.
 * The memory is why callers gate this on an OpenAI-family provider actually
 * being configured — a local-only install must not carry 66MB it never reads.
 * Idempotent: repeated calls reuse the built encoder.
 */
export function warmExactTokenizer(): void {
  getOpenAiEncoding();
}

function serializeForCounting(message: ChatMessage): string {
  const toolCalls = (message.toolCalls ?? []).map((call) => `${call.id}:${call.function.name}:${call.function.arguments}`).join("\n");
  return [message.role, message.name, message.toolCallId, message.content, toolCalls].filter(Boolean).join("\n");
}

export function countChatTokens(messages: ChatMessage[], input: { providerId: string; model: string }): TokenCountResult {
  if (supportsExactOpenAiTokenizer(input.providerId, input.model)) {
    const enc = getOpenAiEncoding();
    const encode = (text: string) => enc.encode(text).length;
    let tokens = 3;
    for (const message of messages) tokens += 4 + memoizedExactMessageTokens(message, encode);
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

/**
 * Upper bound for an opaque serialized payload whose text Morrow does not
 * control — provider continuation blobs and image metadata. One token per byte
 * is deliberately pessimistic here: such a payload can be dense, non-ASCII, or
 * emoji-heavy, where the prose estimator undercounts.
 */
function conservativeSerializedTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  return Math.max(estimateTextTokens(serialized), Buffer.byteLength(serialized, "utf8"));
}

/**
 * Upper bound for the tool schemas Morrow itself authors.
 *
 * This is static, mostly-ASCII JSON with English descriptions, where real
 * tokenizers average roughly 3.5-4 bytes per token. Charging one token per byte
 * over-reserved by about 4x, and because the reserve is subtracted from the
 * same budget that decides compaction, it silently disabled the budget it was
 * meant to protect: live evidence showed a 32k-fallback route billing 12,664
 * tokens for 11 KB of schemas, leaving so little room that every turn compacted
 * and the model lost its own prior observations.
 *
 * Three bytes per token stays conservative against the realistic ~3.7, and the
 * caller adds the standard 15% margin on top, so the reserve still exceeds the
 * true cost by roughly 40% without swallowing the budget. A residual
 * underestimate is recoverable: `context_overflow` is typed and routes into the
 * existing bounded compaction retry.
 */
function conservativeSchemaTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  return Math.max(estimateTextTokens(serialized), Math.ceil(Buffer.byteLength(serialized, "utf8") / 3));
}

/**
 * Tool schemas are the same static objects turn after turn, but serializing and
 * measuring them is proportional to the whole schema set (~11 KB) and was
 * repeated on every measurement. The reserve is a pure function of the schema
 * array, so it is memoized on that array's identity.
 */
const toolSchemaTokenMemo = new WeakMap<readonly ToolDefinition[], number>();

function toolSchemaTokens(tools: readonly ToolDefinition[]): number {
  const cached = toolSchemaTokenMemo.get(tools);
  if (cached !== undefined) return cached;
  const tokens = conservativeSchemaTokens(tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  })));
  toolSchemaTokenMemo.set(tools, tokens);
  return tokens;
}

function conservativeImageTokens(image: NonNullable<ChatMessage["images"]>[number]): number {
  if (image.width !== undefined && image.height !== undefined) {
    // Vision providers charge by decoded pixels/tiles, not base64 wire bytes.
    // One token per 500 pixels deliberately overestimates the supported
    // provider formulas while keeping ordinary screenshots admissible.
    return Math.max(256, Math.ceil((image.width * image.height) / 500));
  }
  return Math.max(512, Math.ceil(Buffer.from(image.data, "base64").length / 64));
}

function canonicalRoute(envelope: ProviderRequestEnvelope): ExactProviderRoute {
  return envelope.route ?? {
    providerId: envelope.providerId,
    modelId: envelope.model,
    protocol: envelope.protocol,
    endpointHost: null,
    endpointIdentityHash: null,
    routeFingerprint: `unbound:${envelope.providerId}:${envelope.model}:${envelope.protocol}`,
  };
}

/** Count the complete normalized request envelope. Provider adapters serialize
 * this same information onto the wire; private continuation data is counted but
 * is never returned in diagnostics. */
export function measureProviderRequest(envelope: ProviderRequestEnvelope): ProviderRequestMeasurement {
  const canonical = buildCanonicalProviderRequest({
    route: canonicalRoute(envelope),
    messages: envelope.messages,
    tools: envelope.tools,
    outputReserveTokens: envelope.outputReserveTokens,
    ...(envelope.visibleContext === undefined ? {} : { visibleContext: envelope.visibleContext }),
  });
  // Counted directly against the caller's message objects. The three excluded
  // fields (providerContinuation, its route binding, and images) are accounted
  // for separately below and are read by neither counter, so the copy this
  // previously made was pure allocation — and it defeated the per-message memo
  // by handing it a fresh object on every measurement.
  const messageCount = countChatTokens(envelope.messages, {
    providerId: envelope.providerId,
    model: envelope.model,
  });
  const imageBase = envelope.messages.reduce((sum, message) => {
    if (!message.images?.length) return sum;
    return sum + message.images.reduce((imageSum, image) => imageSum + conservativeImageTokens(image), 0);
  }, 0);
  const continuationBase = envelope.messages.reduce((sum, message) => {
    if (!message.providerContinuation) return sum;
    return sum + conservativeSerializedTokens(message.providerContinuation);
  }, 0);
  const toolBase = toolSchemaTokens(envelope.tools);
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
    modelVisibleTokens: inputTokens,
    canonicalRequestHash: canonical.requestHash,
    canonicalContentHash: canonical.contentHash,
    provenance: {
      routeFingerprint: canonical.route.routeFingerprint,
      canonicalRequestHash: canonical.requestHash,
      canonicalContentHash: canonical.contentHash,
      method: hasEstimatedExtras ? "estimate" : messageCount.method,
      confidence: hasEstimatedExtras ? "conservative" : messageCount.confidence,
    },
    components: { messages: messageCount.tokens, imageInputs, toolSchemas, providerContinuation, protocolOverhead },
  };
}

export function admitProviderRequest(
  envelope: ProviderRequestEnvelope,
  budget: { usableInputTokens: number | null },
): ProviderAdmission {
  const measurement = measureProviderRequest(envelope);
  return admitMeasuredProviderRequest(measurement, budget);
}

/** Admission over an already measured wire envelope. Kept separate so
 * provider-reported/reproduction measurements can be evaluated with exactly
 * the same limit and output-reserve rule as locally tokenized requests. */
export function admitMeasuredProviderRequest(
  measurement: ProviderRequestMeasurement,
  budget: { usableInputTokens: number | null },
): ProviderAdmission {
  if (budget.usableInputTokens !== null && budget.usableInputTokens !== undefined && measurement.inputTokens > budget.usableInputTokens) {
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
  // A history block with no decisions, paths, commands, or errors has no
  // actionable text to preserve. Keep the summary cursor, but never copy the
  // old first-800-character fallback: repeated filler otherwise becomes a
  // durable system message and teaches the model irrelevant noise.
  if (lines.length === 1) lines.push("No actionable facts extracted.");
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

  // Walk the segments newest-first, accumulating token totals instead of
  // rebuilding and re-counting the whole candidate history for every position.
  // The kept set is identical; only the quadratic array copying is gone.
  const systemTokens = systemMessages.reduce((sum, message) => sum + memoizedEstimateMessageTokens(message), 3);
  const keptSegments: ChatMessage[][] = [];
  let suffixTokens = 0;
  for (let i = nonSystemSegments.length - 1; i >= 0; i--) {
    const segment = nonSystemSegments[i]!;
    suffixTokens += segment.reduce((sum, message) => sum + memoizedEstimateMessageTokens(message), 0);
    if (systemTokens + suffixTokens <= budget.maxInputTokens) {
      keptSegments.unshift(segment);
    } else if (keptSegments.length === 0) {
      keptSegments.unshift(segment);
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
    maxInputTokens?: number | null;
    compact?: boolean;
    recentRawGroups?: number;
  }
): ContextPrepareResult {
  const maxTokens = input.maxInputTokens ?? Infinity;
  const operations: ContextOperation[] = [];
  const count = (candidate: ChatMessage[]) => countChatTokens(candidate, { providerId: input.providerId, model: input.model });
  const firstCount = count(messages);
  operations.push({
    type: firstCount.exact ? "context.exact_count_used" : "context.estimate_used",
    payload: { provider: input.providerId, model: input.model, tokens: firstCount.tokens, method: firstCount.method, exact: firstCount.exact },
  });
  if (firstCount.tokens <= maxTokens) {
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
  if (candidateCount.tokens > maxTokens && summary) {
    operations.push({ type: "context.safety_fallback_applied", payload: { reason: "summary_too_large" } });
    candidate = [...mandatory, ...recent.flat()];
    candidateCount = count(candidate);
  }

  if (candidateCount.tokens > maxTokens) {
    operations.push(
      {
        type: "context.minimum_viable_context_exceeded",
        payload: { finalTokens: candidateCount.tokens, maxInputTokens: input.maxInputTokens ?? 0, provider: input.providerId, model: input.model },
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
