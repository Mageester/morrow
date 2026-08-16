import {
  AiProvider,
  ChatMessage,
  ProviderChunk,
  StreamOptions,
  chatImageDataUrl,
  classifyHttpStatus,
  classifyThrownError,
  validateChatImages,
  type ProviderRouteMetadata,
} from "./base.js";
import { parseRetryAfter } from "./rate-guard.js";
import { reconcileWireLimits } from "./limits.js";
import { translateReasoning } from "./reasoning.js";
import { learnContextLimitFromProviderError } from "./context-limit-discovery.js";
import {
  applyLearnedRequestCompatibility,
  identifyUnsupportedRequestField,
  learnUnsupportedRequestField,
} from "./request-compatibility.js";

export interface OpenAiCompatibleConfig {
  /** Provider identifier surfaced in disclosures (openai, openrouter, deepseek, ...). */
  id: string;
  /** API key. Omitted for keyless local providers such as Ollama. */
  apiKey?: string;
  /** Base URL including the version prefix, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  defaultModel: string;
  /** Extra request headers (e.g. OpenRouter attribution headers). */
  extraHeaders?: Record<string, string>;
  /** Send OpenAI usage streaming option. Disabled for providers that reject it. */
  includeUsage?: boolean;
  route?: ProviderRouteMetadata;
}

/**
 * Streaming adapter for any provider that speaks the OpenAI Chat Completions
 * wire format: OpenAI, OpenRouter, DeepSeek, generic OpenAI-compatible gateways,
 * and the Ollama OpenAI-compatible endpoint. All error shapes are normalized.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  readonly route: ProviderRouteMetadata | undefined;
  constructor(private config: OpenAiCompatibleConfig) {
    this.id = config.id;
    this.route = config.route;
  }

  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    const baseUrl = this.config.baseUrl;
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      yield {
        type: "error",
        error: { type: "security_error", kind: "invalid_request", message: "Invalid endpoint protocol", retryable: false },
      };
      return;
    }
    const imageError = validateChatImages(messages);
    if (imageError) {
      yield { type: "error", error: { type: "invalid_request", kind: "invalid_request", message: imageError, retryable: false } };
      return;
    }

    const model = options.model || this.config.defaultModel;
    // Agent turns can inject `system`-role messages mid-conversation
    // (execution advisories, compaction notices, reminders) — valid input
    // for the Anthropic and Gemini adapters, which already pull all system
    // content out of the transcript and merge it into one field regardless of
    // position. The OpenAI chat-completions wire format instead expects a
    // system message, if any, to be the first entry; several backends
    // (observed via TokenRouter) reject a later one outright with "System
    // message must be at the beginning." Consolidate the same way the other
    // adapters do, so ordering never depends on where in the loop the system
    // content was appended.
    const systemContent = messages
      .filter((m) => m.role === "system" && m.content)
      .map((m) => m.content)
      .join("\n\n");
    const orderedMessages = systemContent
      ? [{ role: "system" as const, content: systemContent }, ...messages.filter((m) => m.role !== "system")]
      : messages;
    const body: Record<string, any> = {
      model,
      messages: orderedMessages.map((m) => ({
        role: m.role,
        content: m.images?.length
          ? [
              { type: "text", text: m.content || "" },
              ...m.images.map((image) => ({ type: "image_url", image_url: { url: chatImageDataUrl(image) } })),
            ]
          : m.content || "",
        ...(m.toolCalls
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: tc.type,
                function: tc.function,
              })),
            }
          : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
        ...(m.providerContinuation?.reasoningContent
          ? { reasoning_content: m.providerContinuation.reasoningContent }
          : {}),
      })),
      stream: true,
      ...(this.config.includeUsage && options.requestCapabilities?.streamUsage !== "unsupported"
        ? { stream_options: { include_usage: true } }
        : {}),
    };

    // Every limit on this request is reconciled against the others in one
    // place (provider/limits.ts) rather than adapter by adapter — most
    // importantly the output ceiling against the deadline, since a reasoning
    // route bills its hidden chain-of-thought against the same allowance and
    // needs the wall clock to match.
    const limits = reconcileWireLimits({
      maxOutputTokens: options.maxOutputTokens,
      timeoutMs: options.timeoutMs,
      temperature: options.temperature,
    });
    if (limits.temperature !== null && options.requestCapabilities?.temperature !== "unsupported") {
      body.temperature = limits.temperature;
    }
    if (limits.maxOutputTokens !== null) {
      switch (options.requestCapabilities?.maxOutputTokens) {
        case "max_completion_tokens":
          body.max_completion_tokens = limits.maxOutputTokens;
          break;
        case "max_output_tokens":
          body.max_output_tokens = limits.maxOutputTokens;
          break;
        default:
          body.max_tokens = limits.maxOutputTokens;
          break;
      }
    }
    if (options.responseFormat === "json_object" && options.requestCapabilities?.responseFormat !== "unsupported") {
      body.response_format = { type: "json_object" };
    }

    if (options.reasoning) {
      const capability = options.exactReasoningCapability ?? options.reasoningCapability ?? { control: "none", efforts: [], budgets: [], source: "unknown" };
      const translated = translateReasoning(options.reasoning, "openai-chat", capability);
      if (!translated.ok) {
        yield { type: "error", error: { type: "invalid_request", kind: "invalid_request", message: translated.reason, retryable: false } };
        return;
      }
      Object.assign(body, translated.params);
    }

    if (options.tools && options.tools.length > 0 && options.requestCapabilities?.tools !== "unsupported") {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (options.toolChoice === "required" && (!options.requestCapabilities || options.requestCapabilities.toolChoice === "supported")) {
        body.tool_choice = "required";
      }
    }
    applyLearnedRequestCompatibility(body, this.route, baseUrl, model);

    const controller = new AbortController();
    let timedOut = false;
    if (options.abortSignal) {
      if (options.abortSignal.aborted) controller.abort();
      else options.abortSignal.addEventListener("abort", () => controller.abort());
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (limits.timeoutMs) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, limits.timeoutMs);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...(this.config.extraHeaders ?? {}),
    };

    let response: Response | undefined;
    let requestCompatibilityRetried = false;
    while (!response) {
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e: any) {
        if (timeoutId) clearTimeout(timeoutId);
        if (timedOut) {
          yield { type: "error", error: { type: "timeout", kind: "timeout", message: "Provider request timed out", retryable: true } };
          return;
        }
        yield { type: "error", error: classifyThrownError(e, options.abortSignal?.aborted ?? false) };
        return;
      }

      if (response.ok) break;

      const errText = await response.text().catch(() => "");
      let errMsg = errText || `Request failed with status ${response.status}`;
      try {
        const parsed = JSON.parse(errText);
        errMsg = parsed?.error?.message || parsed?.message || errMsg;
      } catch {
        /* keep raw text */
      }
      const rejectedField = !requestCompatibilityRetried
        ? identifyUnsupportedRequestField(response.status, errMsg, body)
        : undefined;
      if (rejectedField) {
        requestCompatibilityRetried = true;
        learnUnsupportedRequestField(this.route, baseUrl, model, rejectedField);
        applyLearnedRequestCompatibility(body, this.route, baseUrl, model);
        response = undefined;
        continue;
      }
      // An over-limit rejection is the one place many OpenAI-compatible routes
      // state their real capacity: their model listings disclose none. Record
      // it before surfacing the error, so the next budget resolution for this
      // exact route is based on the provider's own number.
      learnContextLimitFromProviderError(this.route, baseUrl, model, errMsg);
      if (timeoutId) clearTimeout(timeoutId);
      yield { type: "error", error: classifyHttpStatus(response.status, errMsg, parseRetryAfter(response.headers.get("retry-after"))) };
      return;
    }

    if (!response) {
      if (timeoutId) clearTimeout(timeoutId);
      yield { type: "error", error: { type: "provider_error", kind: "provider", message: "Provider request did not return a response", retryable: true } };
      return;
    }

    if (!response.body) {
      if (timeoutId) clearTimeout(timeoutId);
      yield { type: "error", error: { type: "provider_error", kind: "provider", message: "Empty stream response body", retryable: false } };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let completed = false;
    let terminalError = false;
    let finishReason: ProviderChunk["finishReason"];
    let sawUsableOutput = false;
    const redactConfiguredSecret = (message: string): string => this.config.apiKey
      ? message.split(this.config.apiKey).join("***redacted***")
      : message;
    const parseRecord = (line: string, eof = false): ProviderChunk[] => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      if (trimmed === "data: [DONE]") {
        completed = true;
        return [];
      }
      if (!trimmed.startsWith("data: ")) return [];
      let parsed: any;
      try { parsed = JSON.parse(trimmed.slice(6)); }
      catch {
        return eof ? [{ type: "error", error: { type: "malformed_sse", kind: "provider", message: "Malformed trailing SSE record", retryable: false } }] : [];
      }
      const out: ProviderChunk[] = [];
      if (parsed?.error) {
        terminalError = true;
        const numericCode = Number(parsed.error.code);
        const status = Number.isInteger(numericCode) && numericCode >= 400 && numericCode <= 599 ? numericCode : 500;
        const message = redactConfiguredSecret(typeof parsed.error.message === "string" ? parsed.error.message : "Provider stream error");
        out.push({ type: "error", error: classifyHttpStatus(status, message) });
        return out;
      }
      if (parsed.usage) out.push({ type: "done", usage: { promptTokens: parsed.usage.prompt_tokens ?? 0, completionTokens: parsed.usage.completion_tokens ?? 0, ...(parsed.usage.prompt_tokens_details?.cached_tokens !== undefined ? { cachedPromptTokens: parsed.usage.prompt_tokens_details.cached_tokens } : {}) } });
      // A gateway may deliver the last content delta and finish_reason in ONE
      // record. The finish marker is the terminal boundary of the response, so
      // this record's own content must be emitted BEFORE it — otherwise that
      // content either disappears or forces consumers to accept model output
      // after a terminal marker.
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.reasoning_content) out.push({
        type: "text",
        providerContinuation: { reasoningContent: delta.reasoning_content },
      });
      if (delta?.content) {
        sawUsableOutput = true;
        out.push({ type: "text", text: delta.content });
      }
      if (delta?.tool_calls?.length) {
        sawUsableOutput = true;
        out.push({ type: "tool_call", toolCalls: delta.tool_calls.map((tc: any) => ({ id: tc.id, index: tc.index, type: "function", function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" } })) });
      }
      const wireFinishReason = parsed.choices?.[0]?.finish_reason;
      if (wireFinishReason) {
        completed = true;
        finishReason = normalizeFinishReason(wireFinishReason);
        out.push({ type: "done", finishReason });
      }
      return out;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          yield* parseRecord(line);
        }
      }
      buffer += decoder.decode();
      yield* parseRecord(buffer, true);
      if (!completed && !terminalError) {
        yield { type: "error", error: { type: "interrupted_stream", kind: "provider", message: "Provider stream ended before completion", retryable: true } };
      } else if (!terminalError && finishReason === "stop" && !sawUsableOutput) {
        // A clean stop with no visible text or tool call is not a successful
        // assistant turn. Classify it at the provider boundary so the agent
        // can retry the same request path instead of persisting a false final
        // answer. Reasoning-only `length` stops are intentionally left to the
        // agent's bounded recovery policy, which has the route metadata needed
        // to disable thinking where the provider supports it.
        yield {
          type: "error",
          error: {
            type: "empty_response",
            kind: "provider",
            message: "Provider returned a completed response with no content",
            retryable: true,
          },
        };
      }
    } catch (e: any) {
      if (timedOut) {
        yield { type: "error", error: { type: "timeout", kind: "timeout", message: "Provider stream timed out", retryable: true } };
        return;
      }
      yield { type: "error", error: classifyThrownError(e, options.abortSignal?.aborted ?? false) };
      return;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

function normalizeFinishReason(raw: string): "stop" | "length" | "tool_calls" | "content_filter" | "other" {
  switch (raw) {
    case "stop": return "stop";
    case "length": return "length";
    case "tool_calls": case "function_call": return "tool_calls";
    case "content_filter": return "content_filter";
    default: return "other";
  }
}
