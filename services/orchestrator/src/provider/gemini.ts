import {
  AiProvider,
  ChatMessage,
  ProviderChunk,
  StreamOptions,
  classifyHttpStatus,
  classifyThrownError,
} from "./base.js";

export interface GeminiConfig {
  apiKey: string;
  baseUrl: string; // default https://generativelanguage.googleapis.com
  defaultModel: string;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Streaming adapter for the Google Gemini generateContent API. System prompts
 * map to `systemInstruction`, tool calls arrive as complete `functionCall`
 * parts (Gemini does not stream partial arguments) and are emitted as a single
 * normalized tool-call chunk each, with contiguous indices.
 */
export class GeminiProvider implements AiProvider {
  readonly id = "gemini";
  constructor(private config: GeminiConfig) {}

  private buildRequest(messages: ChatMessage[]): { systemInstruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
    const systemParts: string[] = [];
    const contents: GeminiContent[] = [];

    const pushCoalesced = (role: "user" | "model", parts: GeminiPart[]) => {
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push(...parts);
      else contents.push({ role, parts });
    };

    for (const m of messages) {
      if (m.role === "system") {
        if (m.content) systemParts.push(m.content);
        continue;
      }
      if (m.role === "tool") {
        pushCoalesced("user", [
          { functionResponse: { name: m.name ?? "tool", response: { result: m.content } } },
        ]);
        continue;
      }
      if (m.role === "assistant") {
        const parts: GeminiPart[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: tc.function.name, args: tryParseJson(tc.function.arguments || "{}") } });
        }
        if (parts.length === 0) parts.push({ text: "" });
        pushCoalesced("model", parts);
        continue;
      }
      pushCoalesced("user", [{ text: m.content ?? "" }]);
    }

    return {
      ...(systemParts.length ? { systemInstruction: { parts: [{ text: systemParts.join("\n\n") }] } } : {}),
      contents,
    };
  }

  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    const baseUrl = this.config.baseUrl;
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      yield { type: "error", error: { type: "security_error", kind: "invalid_request", message: "Invalid endpoint protocol", retryable: false } };
      return;
    }

    const model = options.model || this.config.defaultModel;
    const { systemInstruction, contents } = this.buildRequest(messages);
    const body: Record<string, any> = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
    };
    const generationConfig: Record<string, any> = {};
    if (typeof options.temperature === "number") generationConfig.temperature = options.temperature;
    if (typeof options.maxOutputTokens === "number") generationConfig.maxOutputTokens = options.maxOutputTokens;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (options.tools && options.tools.length > 0) {
      body.tools = [{ functionDeclarations: options.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
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

    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.config.apiKey },
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
      yield { type: "error", error: classifyHttpStatus(response.status, errMsg) };
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
    let toolOrdinal = 0;
    let sawUsage = false;

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

          if (evt.usageMetadata) {
            sawUsage = true;
            promptTokens = evt.usageMetadata.promptTokenCount ?? promptTokens;
            completionTokens = evt.usageMetadata.candidatesTokenCount ?? completionTokens;
          }

          const parts: GeminiPart[] = evt.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (typeof part.text === "string" && part.text.length) {
              yield { type: "text", text: part.text };
            } else if (part.functionCall) {
              const ordinal = toolOrdinal++;
              yield {
                type: "tool_call",
                toolCalls: [
                  {
                    id: `gemini-tool-${ordinal}`,
                    index: ordinal,
                    type: "function",
                    function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
                  },
                ],
              };
            }
          }
        }
      }
      if (sawUsage) yield { type: "done", usage: { promptTokens, completionTokens } };
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
