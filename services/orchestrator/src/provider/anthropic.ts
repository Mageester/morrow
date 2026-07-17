import {
  AiProvider,
  ChatMessage,
  ProviderChunk,
  StreamOptions,
  classifyHttpStatus,
  classifyThrownError,
  validateChatImages,
  type ProviderRouteMetadata,
} from "./base.js";
import { parseRetryAfter } from "./rate-guard.js";
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
  route?: ProviderRouteMetadata;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/webp"; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

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
    const body: Record<string, any> = {
      model: options.model || this.config.defaultModel,
      max_tokens: options.maxOutputTokens ?? 4096,
      messages: anthropicMessages,
      stream: true,
      ...(system ? { system } : {}),
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    };
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    if (options.reasoning) {
      const capability = options.reasoningCapability ?? { control: "none", efforts: [], budgets: [], source: "unknown" };
      const translated = translateReasoning(options.reasoning, "anthropic-messages", capability);
      if (!translated.ok) {
        yield { type: "error", error: { type: "invalid_request", kind: "invalid_request", message: translated.reason, retryable: false } };
        return;
      }
      Object.assign(body, translated.params);
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
        errMsg = parsed?.error?.message || errMsg;
      } catch {
        /* keep raw */
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
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedPromptTokens = 0;
    // Map Anthropic content-block index -> contiguous tool-call ordinal.
    const blockToToolOrdinal = new Map<number, number>();
    let nextToolOrdinal = 0;

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
            case "message_start":
              promptTokens = evt.message?.usage?.input_tokens ?? 0;
              cachedPromptTokens = evt.message?.usage?.cache_read_input_tokens ?? 0;
              break;
            case "content_block_start": {
              const block = evt.content_block;
              if (block?.type === "tool_use") {
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
              break;
            case "message_stop":
              yield { type: "done", usage: { promptTokens, completionTokens, ...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {}) } };
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
