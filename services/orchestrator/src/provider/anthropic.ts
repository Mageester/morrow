import {
  AiProvider,
  ChatMessage,
  ProviderChunk,
  StreamOptions,
  classifyHttpStatus,
  classifyThrownError,
  linkAbortSignal,
  validateChatImages,
  type ProviderRouteMetadata,
} from "./base.js";
import { parseRetryAfter } from "./rate-guard.js";
import { reconcileWireLimits } from "./limits.js";
import { translateReasoning } from "./reasoning.js";

export interface AnthropicConfig {
  apiKey: string;
  baseUrl: string; // default https://api.anthropic.com
  defaultModel: string;
  anthropicVersion?: string;
  /**
   * OAuth access token from a Claude subscription sign-in. When present it is
   * sent as a Bearer token with the OAuth beta header instead of `x-api-key`,
   * matching the official subscription-login transport.
   */
  oauthToken?: string;
  /**
   * Request prompt caching (default on). Only reason to disable it is a
   * non-Anthropic endpoint behind `baseUrl` that rejects `cache_control`
   * rather than ignoring it.
   */
  promptCache?: boolean;
  route?: ProviderRouteMetadata;
}

/** Marks the end of a cacheable prefix. `ephemeral` is the only type the
 * Messages API defines; its default TTL is five minutes, refreshed on every
 * read, which outlives the gap between turns of an agent loop. */
type CacheControl = { cache_control?: { type: "ephemeral" } };

type AnthropicBlock = CacheControl &
  (
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/webp"; data: string } }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: string }
  );

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** `max_tokens` is required by the Messages API, so an unbudgeted request still
 * has to name a ceiling. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Normalize an Anthropic `stop_reason` into the protocol-independent
 * `finishReason` every adapter reports. `max_tokens` is the load-bearing one:
 * it is how a reasoning model that spent its whole output budget on thinking
 * — returning no visible answer at all — is distinguished from a model that
 * genuinely had nothing to say, and it is what lets mission review retry a
 * truncated response instead of grading an empty one.
 */
function normalizeStopReason(raw: unknown): NonNullable<ProviderChunk["finishReason"]> | undefined {
  switch (raw) {
    case "end_turn": case "stop_sequence": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "refusal": return "content_filter";
    case undefined: case null: return undefined;
    default: return "other";
  }
}

/**
 * Prompt caching, and why the breakpoints sit where they do.
 *
 * An agent turn re-sends the entire conversation: the system prompt, every
 * tool schema, and every prior message. Without a `cache_control` breakpoint
 * all of it is re-read and billed at full input price on every turn, so the
 * cost of a task grows quadratically in its own length. The Messages API
 * caches by exact-prefix match in render order — `tools`, then `system`, then
 * `messages` — and a marker makes everything up to it re-readable at a
 * fraction of the input price for five minutes, refreshed on each read.
 *
 * Morrow already carried the whole downstream half of this: the adapter reads
 * `cache_read_input_tokens`, `routing/usage-snapshot.ts` splits fresh from
 * cached tokens, and the cost model prices cache reads separately. Nothing
 * ever asked for the cache, so that split reported zero forever.
 *
 * Two rolling breakpoints, well inside the limit of four:
 *
 *   1. The last system block. Tools render before system, so one marker there
 *      covers the two largest stable spans — every tool schema and the whole
 *      system prompt — for the life of the task.
 *   2. The last block of the final message. Next turn appends to this exact
 *      prefix, so the entire conversation so far reads from cache. The marker
 *      the previous turn left behind stays a valid read point, which is what
 *      makes the saving accrue as the conversation grows.
 *
 * Both are gated on {@link MIN_CACHEABLE_BYTES}. A prefix under the API's
 * ~1024-token floor never becomes a cache entry, and marking one would risk
 * paying the cache-write premium for a read that cannot happen.
 */
const CACHE_BREAKPOINT = { cache_control: { type: "ephemeral" } } as const;

/**
 * Conservative byte floor standing in for the API's ~1024-token minimum
 * cacheable prefix. English prose and JSON schemas run about four bytes per
 * token, so 4 KB is roughly that floor; erring high only forgoes caching on
 * prompts too small for the saving to matter.
 */
const MIN_CACHEABLE_BYTES = 4096;

function blockBytes(blocks: AnthropicBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "text") total += Buffer.byteLength(block.text, "utf8");
    else if (block.type === "tool_result") total += Buffer.byteLength(block.content, "utf8");
    else if (block.type === "tool_use") total += Buffer.byteLength(JSON.stringify(block.input ?? {}), "utf8");
    // An image is already a cache-sized payload on its own.
    else if (block.type === "image") total += block.source.data.length;
  }
  return total;
}

/** Mark the final block of `blocks` as the end of a cacheable prefix. */
function markCacheBreakpoint(blocks: AnthropicBlock[]): void {
  const last = blocks[blocks.length - 1];
  if (last) Object.assign(last, CACHE_BREAKPOINT);
}

/**
 * Streaming adapter for the Anthropic Messages API. System prompts are hoisted
 * to the top-level `system` field, tool calls are normalized from `tool_use`
 * content blocks, and tool-call indices are remapped to a contiguous, tool-local
 * space so the agent runtime can accumulate streamed argument deltas uniformly.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = "anthropic";
  readonly route: ProviderRouteMetadata | undefined;
  constructor(private config: AnthropicConfig) { this.route = config.route; }

  private buildMessages(messages: ChatMessage[]): { system: string | undefined; messages: AnthropicMessage[] } {
    const systemParts: string[] = [];
    const out: AnthropicMessage[] = [];

    const pushCoalesced = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
      const last = out[out.length - 1];
      if (last && last.role === role) {
        last.content.push(...blocks);
      } else {
        out.push({ role, content: blocks });
      }
    };

    for (const m of messages) {
      if (m.role === "system") {
        if (m.content) systemParts.push(m.content);
        continue;
      }
      if (m.role === "tool") {
        pushCoalesced("user", [
          { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content ?? "" },
        ]);
        continue;
      }
      if (m.role === "assistant") {
        const blocks: AnthropicBlock[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: tryParseJson(tc.function.arguments || "{}") });
        }
        if (blocks.length === 0) blocks.push({ type: "text", text: "" });
        pushCoalesced("assistant", blocks);
        continue;
      }
      // user
      pushCoalesced("user", [
        { type: "text", text: m.content ?? "" },
        ...(m.images ?? []).map((image) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: image.mimeType, data: image.data },
        })),
      ]);
    }

    return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: out };
  }

  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    const baseUrl = this.config.baseUrl;
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      yield { type: "error", error: { type: "security_error", kind: "invalid_request", message: "Invalid endpoint protocol", retryable: false } };
      return;
    }
    const imageError = validateChatImages(messages);
    if (imageError) {
      yield { type: "error", error: { type: "invalid_request", kind: "invalid_request", message: imageError, retryable: false } };
      return;
    }

    const { system, messages: anthropicMessages } = this.buildMessages(messages);
    const cacheEnabled = this.config.promptCache !== false;
    const body: Record<string, any> = {
      model: options.model || this.config.defaultModel,
      messages: anthropicMessages,
      stream: true,
    };
    if (options.tools && options.tools.length > 0 && options.requestCapabilities?.tools !== "unsupported") {
      body.tools = options.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      if (options.toolChoice === "required" && (!options.requestCapabilities || options.requestCapabilities.toolChoice === "supported")) {
        body.tool_choice = { type: "any" };
      }
    }

    // Breakpoint 1: the end of tools+system, the span that is byte-identical
    // for every turn of a task. Sized against the whole stable prefix, since
    // that is what the one marker covers.
    const toolBytes = body.tools ? Buffer.byteLength(JSON.stringify(body.tools), "utf8") : 0;
    const systemBytes = system ? Buffer.byteLength(system, "utf8") : 0;
    const cacheStablePrefix = cacheEnabled && toolBytes + systemBytes >= MIN_CACHEABLE_BYTES;
    if (system) {
      body.system = cacheStablePrefix
        ? [{ type: "text", text: system, ...CACHE_BREAKPOINT }]
        : system;
    } else if (cacheStablePrefix && body.tools?.length) {
      // No system prompt: the tool schemas are the stable prefix, so the
      // marker goes on the last tool instead.
      Object.assign(body.tools[body.tools.length - 1], CACHE_BREAKPOINT);
    }

    // Breakpoint 2: the end of the conversation as it stands. The next turn
    // appends to exactly this prefix and reads all of it back.
    if (cacheEnabled) {
      const conversation = anthropicMessages.reduce((total, message) => total + blockBytes(message.content), 0);
      const lastMessage = anthropicMessages[anthropicMessages.length - 1];
      if (lastMessage && conversation >= MIN_CACHEABLE_BYTES) markCacheBreakpoint(lastMessage.content);
    }

    if (options.reasoning) {
      const capability = options.exactReasoningCapability ?? options.reasoningCapability ?? { control: "none", efforts: [], budgets: [], source: "unknown" };
      const translated = translateReasoning(options.reasoning, "anthropic-messages", capability);
      if (!translated.ok) {
        yield { type: "error", error: { type: "invalid_request", kind: "invalid_request", message: translated.reason, retryable: false } };
        return;
      }
      Object.assign(body, translated.params);
    }

    // Enabling extended thinking constrains two fields this request also
    // carries, and the API rejects the request outright if either conflicts:
    // sampling temperature may not be combined with thinking, and `max_tokens`
    // must leave room for the visible answer *on top of* the thinking budget.
    // The adapter states what the protocol requires; provider/limits.ts owns
    // the arithmetic for every such coupling in one place, so no caller — and
    // no future adapter — has to remember it. The preset that supplies
    // temperature and the output budget cannot see the reasoning mode.
    const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
    const thinkingEnabled = thinking?.type === "enabled";
    const requestedOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const limits = reconcileWireLimits({
      maxOutputTokens: requestedOutputTokens,
      timeoutMs: options.timeoutMs,
      temperature: options.temperature,
      ...(thinkingEnabled ? { reasoningBudgetTokens: thinking?.budget_tokens ?? 0 } : {}),
      reasoningExcludesTemperature: true,
      // Preserve the caller's full allowance as visible-answer room rather than
      // spending it on thinking: an explicit output budget states how much
      // ANSWER was asked for.
      visibleAnswerFloorTokens: requestedOutputTokens,
    });
    body.max_tokens = limits.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (limits.temperature !== null && options.requestCapabilities?.temperature !== "unsupported") body.temperature = limits.temperature;

    const controller = new AbortController();
    let timedOut = false;
    const detachAbort = linkAbortSignal(options.abortSignal, controller);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (limits.timeoutMs) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, limits.timeoutMs);
    }

    /** Release everything this one request holds: the timeout, and the
     * listener on the caller's longer-lived abort signal. */
    const releaseRequest = (): void => {
      detachAbort();
      if (timeoutId) clearTimeout(timeoutId);
    };

    let response: Response;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": this.config.anthropicVersion ?? "2023-06-01",
      };
      if (this.config.oauthToken) {
        // Subscription (OAuth) transport: Bearer token + OAuth beta header,
        // with no x-api-key. Mirrors the official Claude subscription login.
        headers["Authorization"] = `Bearer ${this.config.oauthToken}`;
        headers["anthropic-beta"] = "oauth-2025-04-20";
      } else {
        headers["x-api-key"] = this.config.apiKey;
      }
      response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: any) {
      releaseRequest();
      if (timedOut) {
        yield { type: "error", error: { type: "timeout", kind: "timeout", message: "Provider request timed out", retryable: true } };
        return;
      }
      yield { type: "error", error: classifyThrownError(e, options.abortSignal?.aborted ?? false) };
      return;
    }

    if (!response.ok) {
      releaseRequest();
      const errText = await response.text().catch(() => "");
      let errMsg = errText || `Request failed with status ${response.status}`;
      try {
        const parsed = JSON.parse(errText);
        errMsg = parsed?.error?.message || errMsg;
      } catch {
        /* keep raw */
      }
      yield { type: "error", error: classifyHttpStatus(response.status, errMsg, parseRetryAfter(response.headers.get("retry-after"))) };
      return;
    }

    if (!response.body) {
      releaseRequest();
      yield { type: "error", error: { type: "provider_error", kind: "provider", message: "Empty stream response body", retryable: false } };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedPromptTokens = 0;
    // Map Anthropic content-block index -> contiguous tool-call ordinal.
    const blockToToolOrdinal = new Map<number, number>();
    let nextToolOrdinal = 0;
    let finishReason: NonNullable<ProviderChunk["finishReason"]> | undefined;
    let sawUsableOutput = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          let evt: any;
          try {
            evt = JSON.parse(trimmed.slice(6));
          } catch {
            continue;
          }

          switch (evt.type) {
            case "message_start": {
              // Anthropic splits input three ways and `input_tokens` counts
              // only the part that neither hit nor filled the cache; the total
              // read is the sum of all three. Every consumer downstream —
              // `routing/usage-snapshot.ts`, `calculateUsageCost` — defines
              // promptTokens as the whole input with `cachedPromptTokens` as a
              // subset of it, so the sum is what gets reported. Passing
              // Anthropic's `input_tokens` through unchanged would, the moment
              // caching started hitting, under-report both the context size and
              // the bill, and drive the fresh/cached split to zero.
              const usage = evt.message?.usage;
              const uncached = usage?.input_tokens ?? 0;
              cachedPromptTokens = usage?.cache_read_input_tokens ?? 0;
              // A cache write is fresh input the model read for the first time;
              // it is billed at a premium over ordinary input, which the shared
              // cost model has no separate rate for, so it counts as fresh.
              promptTokens = uncached + cachedPromptTokens + (usage?.cache_creation_input_tokens ?? 0);
              break;
            }
            case "content_block_start": {
              const block = evt.content_block;
              if (block?.type === "tool_use") {
                sawUsableOutput = true;
                const ordinal = nextToolOrdinal++;
                blockToToolOrdinal.set(evt.index, ordinal);
                yield {
                  type: "tool_call",
                  toolCalls: [{ id: block.id, index: ordinal, type: "function", function: { name: block.name, arguments: "" } }],
                };
              }
              break;
            }
            case "content_block_delta": {
              const delta = evt.delta;
              if (delta?.type === "text_delta" && delta.text) {
                sawUsableOutput = true;
                yield { type: "text", text: delta.text };
              } else if (delta?.type === "input_json_delta") {
                const ordinal = blockToToolOrdinal.get(evt.index) ?? 0;
                yield {
                  type: "tool_call",
                  toolCalls: [{ id: "", index: ordinal, type: "function", function: { name: "", arguments: delta.partial_json ?? "" } }],
                };
              }
              break;
            }
            case "message_delta":
              if (evt.usage?.output_tokens !== undefined) completionTokens = evt.usage.output_tokens;
              finishReason = normalizeStopReason(evt.delta?.stop_reason) ?? finishReason;
              break;
            case "message_stop":
              yield {
                type: "done",
                usage: { promptTokens, completionTokens, ...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {}) },
                ...(finishReason ? { finishReason } : {}),
              };
              break;
            case "error": {
              const apiType = evt.error?.type ?? "provider_error";
              const retryable = apiType === "overloaded_error" || apiType === "rate_limit_error";
              const kind = apiType === "authentication_error" ? "auth" : retryable ? "rate_limit" : "provider";
              yield { type: "error", error: { type: apiType, kind, message: evt.error?.message || "Provider error", retryable } };
              return;
            }
            default:
              break;
          }
        }
      }
      if (finishReason === "stop" && !sawUsableOutput) {
        yield { type: "error", error: { type: "empty_response", kind: "provider", message: "Provider returned a completed response with no content", retryable: true } };
      }
    } catch (e: any) {
      if (timedOut) {
        yield { type: "error", error: { type: "timeout", kind: "timeout", message: "Provider stream timed out", retryable: true } };
        return;
      }
      yield { type: "error", error: classifyThrownError(e, options.abortSignal?.aborted ?? false) };
      return;
    } finally {
      releaseRequest();
    }
  }
}
