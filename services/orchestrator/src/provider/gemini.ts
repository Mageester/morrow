import { randomUUID } from "node:crypto";
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
import { reconcileWireLimits } from "./limits.js";
import { translateReasoning } from "./reasoning.js";
import { learnContextLimitFromProviderError } from "./context-limit-discovery.js";

export interface GeminiConfig {
  apiKey: string;
  baseUrl: string; // default https://generativelanguage.googleapis.com
  defaultModel: string;
  route?: ProviderRouteMetadata;
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
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  inlineData?: { mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string };
  functionCall?: { name: string; args: unknown; thoughtSignature?: string; thought_signature?: string };
  functionResponse?: { name: string; response: unknown };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Normalize a Gemini candidate `finishReason` into the protocol-independent
 * `finishReason` every adapter reports. `MAX_TOKENS` is the load-bearing one:
 * it is how a model that spent its whole output budget — returning no visible
 * answer at all — is told apart from one that genuinely had nothing to say,
 * and it is what lets mission review retry a truncated response instead of
 * grading an empty one (mission/completion.ts). Until this existed, that
 * retry was dead on every Gemini route.
 *
 * Gemini reports `STOP` even when the candidate's only content was a
 * `functionCall`, so the caller passes whether this stream emitted tool calls
 * and a clean stop is reported as `tool_calls` — matching what every other
 * adapter reports for the same situation.
 */
function normalizeGeminiFinishReason(
  raw: unknown,
  sawToolCall: boolean
): NonNullable<ProviderChunk["finishReason"]> | undefined {
  switch (raw) {
    case "STOP": return sawToolCall ? "tool_calls" : "stop";
    case "MAX_TOKENS": return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "content_filter";
    case undefined: case null: case "FINISH_REASON_UNSPECIFIED": return undefined;
    default: return "other";
  }
}

/**
 * Streaming adapter for the Google Gemini generateContent API. System prompts
 * map to `systemInstruction`, tool calls arrive as complete `functionCall`
 * parts (Gemini does not stream partial arguments) and are emitted as a single
 * normalized tool-call chunk each, with contiguous indices.
 *
 * Gemini's wire format carries no tool-call identity of its own — it matches a
 * `functionResponse` back to its call by tool NAME — so this adapter has to
 * synthesize one. The id must be unique across every stream, not just within
 * one: the durable transcript stores tool calls in a table keyed globally on
 * that id, so a per-turn ordinal alone (`gemini-tool-0`) silently collided
 * with the previous turn's first call and with every other Gemini task's, and
 * the colliding write updated the earlier row instead of recording a new one.
 * Each streamChat call therefore gets its own nonce, keeping the id opaque and
 * globally unique while the ordinal stays readable.
 */
export class GeminiProvider implements AiProvider {
  readonly id = "gemini";
  readonly route: ProviderRouteMetadata | undefined;
  constructor(private config: GeminiConfig) { this.route = config.route; }

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
        const opaque = m.providerContinuation?.opaque;
        const defaultSignature = typeof opaque?.thoughtSignature === "string"
          ? opaque.thoughtSignature
          : typeof (opaque as any)?.thought_signature === "string"
            ? (opaque as any).thought_signature
            : undefined;
        const toolCallSignatures = (opaque?.toolCallSignatures && typeof opaque.toolCallSignatures === "object")
          ? opaque.toolCallSignatures as Record<string, string>
          : undefined;

        if (m.content) parts.push({ text: m.content });
        const toolCalls = m.toolCalls ?? [];
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i]!;
          const sig = toolCallSignatures?.[tc.id] ?? toolCallSignatures?.[String(i)] ?? (i === 0 ? defaultSignature : undefined);
          const part: GeminiPart = {
            functionCall: { name: tc.function.name, args: tryParseJson(tc.function.arguments || "{}") },
            ...(sig ? { thoughtSignature: sig } : {}),
          };
          parts.push(part);
        }
        if (parts.length === 0) parts.push({ text: "" });
        pushCoalesced("model", parts);
        continue;
      }
      pushCoalesced("user", [
        { text: m.content ?? "" },
        ...(m.images ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
      ]);
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
    const imageError = validateChatImages(messages);
    if (imageError) {
      yield { type: "error", error: { type: "invalid_request", kind: "invalid_request", message: imageError, retryable: false } };
      return;
    }

    const model = options.model || this.config.defaultModel;
    const { systemInstruction, contents } = this.buildRequest(messages);
    const body: Record<string, any> = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
    };
    // One boundary reconciles this request's limits against each other; see
    // provider/limits.ts. Notably the output ceiling and the deadline, which
    // are only valid relative to one another.
    const limits = reconcileWireLimits({
      maxOutputTokens: options.maxOutputTokens,
      timeoutMs: options.timeoutMs,
      temperature: options.temperature,
    });
    const generationConfig: Record<string, any> = {};
    if (limits.temperature !== null && options.requestCapabilities?.temperature !== "unsupported") generationConfig.temperature = limits.temperature;
    if (limits.maxOutputTokens !== null) generationConfig.maxOutputTokens = limits.maxOutputTokens;
    // Gemini carries thinking depth inside generationConfig rather than as a
    // top-level field. The translator owns which level id maps to which wire
    // value; this adapter only knows where Gemini expects the result to sit.
    if (options.reasoning) {
      const capability = options.exactReasoningCapability ?? options.reasoningCapability ?? { control: "unknown", efforts: [], budgets: [], source: "unknown" };
      const translated = translateReasoning(options.reasoning, "gemini-generate-content", capability);
      if (!translated.ok) {
        yield { type: "error", error: { type: "invalid_request", kind: "invalid_request", message: translated.reason, retryable: false } };
        return;
      }
      Object.assign(generationConfig, translated.params);
    }
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (options.tools && options.tools.length > 0 && options.requestCapabilities?.tools !== "unsupported") {
      body.tools = [{ functionDeclarations: options.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      if (options.toolChoice === "required" && options.requestCapabilities?.toolChoice === "supported") {
        body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
      }
    }

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
      // Gemini's listing already reports inputTokenLimit, so this rarely adds a
      // fact — but a rejection from a proxied or restricted deployment states
      // what THAT route enforces, which the listing cannot know.
      learnContextLimitFromProviderError(this.route, baseUrl, model, errMsg);
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
    let toolOrdinal = 0;
    let sawUsage = false;
    let sawToolCall = false;
    let sawVisibleOutput = false;
    let sawReasoningOutput = false;
    let rawFinishReason: unknown;
    let latestThoughtSignature: string | undefined;
    const toolCallSignatures: Record<string, string> = {};
    let accumulatedReasoning = "";
    // Unique per stream; see the class docstring for why an ordinal alone is
    // not a safe tool-call identity.
    const toolCallNonce = randomUUID().slice(0, 8);

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

          // Gemini reports the reason it stopped on the candidate itself, and
          // may repeat or refine it across events; the last one observed wins.
          if (evt.candidates?.[0]?.finishReason) rawFinishReason = evt.candidates[0].finishReason;

          const parts: GeminiPart[] = evt.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            const sig = part.thoughtSignature
              ?? (part as any).thought_signature
              ?? part.functionCall?.thoughtSignature
              ?? (part.functionCall as any)?.thought_signature;
            if (sig) latestThoughtSignature = sig;

            if (part.thought === true && typeof part.text === "string" && part.text.length) {
              sawReasoningOutput = true;
              accumulatedReasoning += part.text;
              yield {
                type: "text",
                providerContinuation: {
                  reasoningContent: part.text,
                  ...(sig ? { opaque: { thoughtSignature: sig } } : {}),
                },
              };
            } else if (typeof part.text === "string" && part.text.length) {
              sawVisibleOutput = true;
              yield {
                type: "text",
                text: part.text,
                ...(sig ? { providerContinuation: { opaque: { thoughtSignature: sig } } } : {}),
              };
            } else if (part.functionCall) {
              sawToolCall = true;
              const ordinal = toolOrdinal++;
              const toolCallId = `gemini-tool-${toolCallNonce}-${ordinal}`;
              const callSig = sig ?? latestThoughtSignature;
              if (callSig) {
                toolCallSignatures[toolCallId] = callSig;
                toolCallSignatures[String(ordinal)] = callSig;
              }
              yield {
                type: "tool_call",
                toolCalls: [
                  {
                    id: toolCallId,
                    index: ordinal,
                    type: "function",
                    function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
                  },
                ],
                ...(callSig ? {
                  providerContinuation: {
                    opaque: {
                      thoughtSignature: callSig,
                      toolCallSignatures: { ...toolCallSignatures },
                    },
                  },
                } : {}),
              };
            }
          }
        }
      }
      // A terminal `done` is emitted unconditionally. It is the only chunk
      // that can carry `finishReason`, and gating it on usage metadata — which
      // Gemini omits on some responses, truncated ones included — is what made
      // truncation unobservable on this route. Usage stays conditional so an
      // absent count is never reported as zero.
      const finishReason = normalizeGeminiFinishReason(rawFinishReason, sawToolCall);
      const hasContinuation = accumulatedReasoning.length > 0 || latestThoughtSignature !== undefined;
      const continuation = hasContinuation
        ? {
            ...(accumulatedReasoning.length > 0 ? { reasoningContent: accumulatedReasoning } : {}),
            ...(latestThoughtSignature ? {
              opaque: {
                thoughtSignature: latestThoughtSignature,
                ...(Object.keys(toolCallSignatures).length > 0 ? { toolCallSignatures: { ...toolCallSignatures } } : {}),
              },
            } : {}),
          }
        : undefined;
      yield {
        type: "done",
        ...(sawUsage ? { usage: { promptTokens, completionTokens } } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(continuation ? { providerContinuation: continuation } : {}),
      };
      if (finishReason === "stop" && !sawVisibleOutput && !sawToolCall && !sawReasoningOutput) {
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
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
