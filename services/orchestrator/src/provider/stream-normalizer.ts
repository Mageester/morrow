import { randomUUID } from "node:crypto";
import { redactSecrets } from "./credentials.js";
import { ProviderError, type ProviderChunk, type ProviderErrorKind, type ToolCall } from "./base.js";

export interface NormalizeProviderStreamOptions {
  abortSignal?: AbortSignal;
}

export interface AssembledProviderToolCall {
  id: string;
  index: number;
  name: string;
  arguments: string;
}

const PROVIDER_ERROR_KINDS: ReadonlySet<string> = new Set([
  "auth",
  "rate_limit",
  "timeout",
  "network",
  "cancelled",
  "invalid_request",
  "context_overflow",
  "provider",
  "unknown",
]);

function cancelled(): ProviderError {
  return new ProviderError("cancelled", "Request cancelled", { kind: "cancelled", retryable: false });
}

function malformed(message: string): ProviderChunk {
  return {
    type: "error",
    error: {
      type: "malformed_stream",
      kind: "provider",
      message,
      retryable: false,
    },
  };
}

function normalizeErrorChunk(chunk: ProviderChunk): ProviderChunk {
  const error = chunk.error;
  if (!error || typeof error !== "object") return malformed("Provider emitted an error without an error payload");
  const kind: ProviderErrorKind = PROVIDER_ERROR_KINDS.has(error.kind) ? error.kind as ProviderErrorKind : "unknown";
  const message = typeof error.message === "string" && error.message.trim().length > 0
    ? redactSecrets(error.message)
    : "Provider stream error";
  return {
    type: "error",
    error: {
      type: typeof error.type === "string" && error.type.trim().length > 0 ? error.type : "provider_error",
      kind,
      message,
      retryable: error.retryable === true,
      ...(typeof error.status === "number" ? { status: error.status } : {}),
      ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
    },
  };
}

function mergeUsage(
  previous: ProviderChunk["usage"] | undefined,
  next: ProviderChunk["usage"] | undefined,
): ProviderChunk["usage"] | undefined {
  if (!previous) return next;
  if (!next) return previous;
  return {
    // A provider may send prompt usage in an early metadata marker and
    // completion usage in a later terminal marker. Prefer non-zero later
    // values without ever adding two snapshots together.
    promptTokens: next.promptTokens !== 0 ? next.promptTokens : previous.promptTokens,
    completionTokens: next.completionTokens !== 0 ? next.completionTokens : previous.completionTokens,
    ...(next.cachedPromptTokens !== undefined
      ? { cachedPromptTokens: next.cachedPromptTokens }
      : previous.cachedPromptTokens !== undefined
        ? { cachedPromptTokens: previous.cachedPromptTokens }
        : {}),
  };
}

function hasTextOutput(chunk: ProviderChunk): boolean {
  return chunk.type === "text" && typeof chunk.text === "string" && chunk.text.length > 0;
}

function hasReasoningOutput(chunk: ProviderChunk): boolean {
  return chunk.type === "text" && typeof chunk.providerContinuation?.reasoningContent === "string"
    && chunk.providerContinuation.reasoningContent.length > 0;
}

function normalizedToolCalls(
  calls: unknown,
  indexMap: Map<string, number>,
  idMap: Map<number, string>,
  providerNamed: Set<number>,
  nextIndex: { value: number },
): ToolCall[] | undefined {
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  return calls.map((candidate, position) => {
    if (!candidate || typeof candidate !== "object") throw new Error("Provider emitted a malformed tool call");
    const raw = candidate as Partial<ToolCall>;
    if (!raw.function || typeof raw.function !== "object") throw new Error("Provider emitted a tool call without a function payload");
    const rawFunction = raw.function as Partial<ToolCall["function"]>;
    if (rawFunction.name !== undefined && typeof rawFunction.name !== "string") throw new Error("Provider emitted a non-string tool name");
    if (rawFunction.arguments !== undefined && typeof rawFunction.arguments !== "string") throw new Error("Provider emitted non-string tool arguments");
    const rawWireIndex = Number.isInteger(raw.index) ? raw.index as number : undefined;
    const key = rawWireIndex === undefined ? `implicit:${position}` : `wire:${rawWireIndex}`;
    let index = indexMap.get(key);
    if (index === undefined) {
      index = nextIndex.value++;
      indexMap.set(key, index);
    }
    // One index is one call, and its id must never move once settled. A
    // gateway that re-sends a different id on a later fragment would otherwise
    // split one call in two, or leave the executed id different from the id
    // already streamed to the UI and persisted with the turn. A synthesized
    // placeholder may be upgraded exactly once to the provider's own id —
    // after that, the first provider-supplied id is final.
    const providerId = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : undefined;
    const settled = idMap.get(index);
    let id: string;
    if (settled !== undefined && (providerNamed.has(index) || providerId === undefined)) {
      id = settled;
    } else if (providerId !== undefined) {
      id = providerId;
      providerNamed.add(index);
    } else {
      id = `morrow-tool-${randomUUID()}`;
    }
    idMap.set(index, id);
    return {
      id,
      index,
      type: "function" as const,
      function: {
        name: rawFunction.name ?? "",
        arguments: rawFunction.arguments ?? "",
      },
    };
  });
}

/**
 * Reassemble normalized tool-call deltas without parsing JSON prematurely.
 * Providers are allowed to fragment JSON arbitrarily; parsing belongs after
 * the terminal boundary, when all parallel calls have been collected.
 */
export function assembleProviderToolCalls(chunks: Iterable<ProviderChunk>): AssembledProviderToolCall[] {
  const byIndex = new Map<number, AssembledProviderToolCall>();
  for (const chunk of chunks) {
    if (chunk.type !== "tool_call") continue;
    for (const call of chunk.toolCalls ?? []) {
      const index = call.index ?? 0;
      const current = byIndex.get(index) ?? { id: "", index, name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function.name) current.name = call.function.name;
      current.arguments += call.function.arguments ?? "";
      byIndex.set(index, current);
    }
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

/**
 * Normalize provider-specific stream markers into one terminal state machine.
 * Text and tool deltas remain incremental; usage and finish markers are
 * buffered so the consumer observes exactly one terminal `done` event.
 */
export async function* normalizeProviderStream(
  source: AsyncIterable<ProviderChunk>,
  options: NormalizeProviderStreamOptions = {},
): AsyncIterable<ProviderChunk> {
  let sawAny = false;
  let sawVisibleOutput = false;
  let sawReasoningOutput = false;
  let sawToolCall = false;
  let sawCompletionMarker = false;
  let finishReason: ProviderChunk["finishReason"];
  let usage: ProviderChunk["usage"];
  let terminalContinuation: ProviderChunk["providerContinuation"];
  let terminal = false;
  const indexMap = new Map<string, number>();
  const idMap = new Map<number, string>();
  const providerNamed = new Set<number>();
  const nextIndex = { value: 0 };

  for await (const raw of source) {
    if (options.abortSignal?.aborted) throw cancelled();
    if (terminal) return;
    sawAny = true;
    if (!raw || typeof raw !== "object" || typeof raw.type !== "string") {
      yield malformed("Provider emitted a chunk without a valid type");
      return;
    }

    if (raw.type === "error") {
      const normalized = normalizeErrorChunk(raw);
      yield normalized;
      terminal = true;
      return;
    }

    // A finish reason is the terminal boundary of this response. Model output
    // that arrives afterwards belongs to no turn Morrow asked for: a proxy or
    // gateway that concatenates a second response onto the same stream must not
    // be able to blend its text into this answer or get its tool calls
    // executed. Trailing usage/continuation markers are still legitimate and
    // continue to be folded in below.
    if (finishReason !== undefined && (raw.type === "text" || raw.type === "tool_call")) continue;

    if (raw.type === "text") {
      if (!hasTextOutput(raw) && !hasReasoningOutput(raw)) {
        yield malformed("Provider emitted an empty text chunk");
        return;
      }
      sawVisibleOutput ||= hasTextOutput(raw);
      sawReasoningOutput ||= hasReasoningOutput(raw);
      yield {
        type: "text",
        ...(typeof raw.text === "string" && raw.text.length > 0 ? { text: raw.text } : {}),
        ...(raw.providerContinuation ? { providerContinuation: raw.providerContinuation } : {}),
      };
      continue;
    }

    if (raw.type === "tool_call") {
      try {
        const toolCalls = normalizedToolCalls(raw.toolCalls, indexMap, idMap, providerNamed, nextIndex);
        if (!toolCalls) {
          yield malformed("Provider emitted a tool-call chunk without tool calls");
          return;
        }
        sawToolCall = true;
        if (raw.providerContinuation !== undefined) {
          if (terminalContinuation === undefined) {
            terminalContinuation = raw.providerContinuation;
          } else {
            terminalContinuation = {
              ...(terminalContinuation.reasoningContent || raw.providerContinuation.reasoningContent ? {
                reasoningContent: (terminalContinuation.reasoningContent ?? "") + (raw.providerContinuation.reasoningContent ?? ""),
              } : {}),
              ...(terminalContinuation.opaque || raw.providerContinuation.opaque ? {
                opaque: { ...(terminalContinuation.opaque ?? {}), ...(raw.providerContinuation.opaque ?? {}) },
              } : {}),
            };
          }
        }
        yield {
          type: "tool_call",
          toolCalls,
          ...(raw.providerContinuation ? { providerContinuation: raw.providerContinuation } : {}),
        };
      } catch (error) {
        yield malformed(error instanceof Error ? error.message : "Provider emitted a malformed tool call");
        return;
      }
      continue;
    }

    if (raw.type === "done") {
      sawCompletionMarker = true;
      const hadFinishReason = finishReason !== undefined;
      // Once a terminal reason has been observed, a later duplicate marker
      // must not overwrite the usage snapshot with a second response. A
      // usage-only marker after the reason is still accepted because some
      // protocols deliver those fields in the opposite order.
      if (!hadFinishReason || raw.finishReason === undefined) usage = mergeUsage(usage, raw.usage);
      if (finishReason === undefined && raw.finishReason !== undefined) finishReason = raw.finishReason;
      if (raw.providerContinuation !== undefined) {
        if (terminalContinuation === undefined) {
          terminalContinuation = raw.providerContinuation;
        } else {
          terminalContinuation = {
            ...(terminalContinuation.reasoningContent || raw.providerContinuation.reasoningContent ? {
              reasoningContent: (terminalContinuation.reasoningContent ?? "") + (raw.providerContinuation.reasoningContent ?? ""),
            } : {}),
            ...(terminalContinuation.opaque || raw.providerContinuation.opaque ? {
              opaque: { ...(terminalContinuation.opaque ?? {}), ...(raw.providerContinuation.opaque ?? {}) },
            } : {}),
          };
        }
      }
      continue;
    }

    yield malformed(`Provider emitted unsupported chunk type ${raw.type}`);
    return;
  }

  if (options.abortSignal?.aborted) throw cancelled();
  if (terminal) return;
  if (!sawCompletionMarker) {
    yield {
      type: "error",
      error: {
        type: sawAny ? "interrupted_stream" : "empty_response",
        kind: "provider",
        message: sawAny ? "Provider stream ended before completion" : "Provider returned an empty response",
        retryable: true,
      },
    };
    return;
  }
  if (!finishReason) finishReason = "other";
  if (!sawVisibleOutput && !sawToolCall && !sawReasoningOutput && finishReason === "stop") {
    yield {
      type: "error",
      error: {
        type: "empty_response",
        kind: "provider",
        message: "Provider returned a completed response with no content",
        retryable: true,
      },
    };
    return;
  }
  yield {
    type: "done",
    ...(usage ? { usage } : {}),
    finishReason,
    ...(terminalContinuation ? { providerContinuation: terminalContinuation } : {}),
  };
}
