import {
  AiProvider,
  ChatMessage,
  ProviderChunk,
  StreamOptions,
  classifyHttpStatus,
  classifyThrownError,
} from "./base.js";
import { parseRetryAfter } from "./rate-guard.js";

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
}

/**
 * Streaming adapter for any provider that speaks the OpenAI Chat Completions
 * wire format: OpenAI, OpenRouter, DeepSeek, generic OpenAI-compatible gateways,
 * and the Ollama OpenAI-compatible endpoint. All error shapes are normalized.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  constructor(private config: OpenAiCompatibleConfig) {
    this.id = config.id;
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

    const model = options.model || this.config.defaultModel;
    const body: Record<string, any> = {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content || "",
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
      })),
      stream: true,
      ...(this.config.includeUsage ? { stream_options: { include_usage: true } } : {}),
    };

    if (typeof options.temperature === "number") body.temperature = options.temperature;
    if (typeof options.maxOutputTokens === "number") body.max_tokens = options.maxOutputTokens;
    if (options.responseFormat === "json_object") body.response_format = { type: "json_object" };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const controller = new AbortController();
    let timedOut = false;
    if (options.abortSignal) {
      if (options.abortSignal.aborted) controller.abort();
      else options.abortSignal.addEventListener("abort", () => controller.abort());
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...(this.config.extraHeaders ?? {}),
    };

    let response: Response;
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

    if (!response.ok) {
      if (timeoutId) clearTimeout(timeoutId);
      const errText = await response.text().catch(() => "");
      let errMsg = errText || `Request failed with status ${response.status}`;
      try {
        const parsed = JSON.parse(errText);
        errMsg = parsed?.error?.message || parsed?.message || errMsg;
      } catch {
        /* keep raw text */
      }
      yield { type: "error", error: classifyHttpStatus(response.status, errMsg, parseRetryAfter(response.headers.get("retry-after"))) };
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          let parsed: any;
          try {
            parsed = JSON.parse(trimmed.slice(6));
          } catch {
            continue;
          }

          if (parsed.usage) {
            yield {
              type: "done",
              usage: {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                ...(parsed.usage.prompt_tokens_details?.cached_tokens !== undefined ? { cachedPromptTokens: parsed.usage.prompt_tokens_details.cached_tokens } : {}),
              },
            };
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            yield { type: "text", text: delta.content };
          }
          if (delta.tool_calls) {
            yield {
              type: "tool_call",
              toolCalls: delta.tool_calls.map((tc: any) => ({
                id: tc.id,
                index: tc.index,
                type: "function",
                function: {
                  name: tc.function?.name || "",
                  arguments: tc.function?.arguments || "",
                },
              })),
            };
          }
        }
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
