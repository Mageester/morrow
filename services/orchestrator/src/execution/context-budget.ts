import type { ChatMessage } from "../provider/base.js";

export interface ContextBudget {
  maxInputTokens: number;
}

export interface ContextTrimResult {
  messages: ChatMessage[];
  originalTokens: number;
  finalTokens: number;
  trimmedMessages: number;
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

export function trimMessagesToBudget(messages: ChatMessage[], budget: ContextBudget): ContextTrimResult {
  const originalTokens = estimateChatTokens(messages);
  if (originalTokens <= budget.maxInputTokens) {
    return { messages, originalTokens, finalTokens: originalTokens, trimmedMessages: 0 };
  }

  const systemMessages = messages.filter((message) => message.role === "system");
  const nonSystemSegments: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool" && nonSystemSegments.length > 0) {
      nonSystemSegments[nonSystemSegments.length - 1]!.push(message);
    } else {
      nonSystemSegments.push([message]);
    }
  }

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
