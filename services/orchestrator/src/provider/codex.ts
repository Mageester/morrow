import {
  AiProvider,
  ChatMessage,
  ProviderChunk,
  StreamOptions,
  classifyHttpStatus,
  classifyThrownError,
} from "./base.js";

/**
 * Streaming adapter for OpenAI's ChatGPT/Codex subscription backend
 * (`chatgpt.com/backend-api/codex/responses`, the Responses API surface).
 *
 * A ChatGPT/Codex OAuth token does NOT work against `api.openai.com` — the
 * Cloudflare layer in front of the Codex backend returns 403 unless the request
 * advertises a first-party originator. This adapter mirrors what the official
 * Codex CLI does: it targets the Codex backend, pins `originator: codex_cli_rs`
 * + a codex-shaped User-Agent, and sends `ChatGPT-Account-ID` extracted from the
 * access token's JWT claim. The request/response uses the Responses API (not
 * Chat Completions): system → `instructions`, messages → `input` items, and the
 * SSE stream emits `response.output_text.delta` / `response.output_item.*` /
 * `response.completed` events.
 */
export interface CodexConfig {
  /** ChatGPT/Codex OAuth access token (a JWT). */
  oauthToken: string;
  defaultModel: string;
  baseUrl?: string; // default https://chatgpt.com/backend-api/codex
}

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Default model when nothing Codex-shaped was requested. */
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
/** Codex backend only serves its own slugs (gpt-5.x / *codex*), not api.openai.com ids. */
function isCodexModel(m: string | undefined | null): boolean {
  return !!m && (/^gpt-5/i.test(m) || /codex/i.test(m));
}

/** Pull the ChatGPT account id out of the access-token JWT (claim used by codex-rs). */
export function extractChatgptAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    const acct = json?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof acct === "string" && acct ? acct : null;
  } catch {
    return null;
  }
}

/** Cloudflare-safe headers required by the Codex backend. */
export function codexHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0 (Morrow)",
  };
  const acct = extractChatgptAccountId(accessToken);
  if (acct) headers["ChatGPT-Account-ID"] = acct;
  return headers;
}

type ResponsesItem =
  | { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export class CodexProvider implements AiProvider {
  readonly id = "openai";
  constructor(private config: CodexConfig) {}

  private buildRequest(messages: ChatMessage[]): { instructions: string | undefined; input: ResponsesItem[] } {
    const instructionParts: string[] = [];
    const input: ResponsesItem[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        if (m.content) instructionParts.push(m.content);
        continue;
      }
      if (m.role === "tool") {
        input.push({ type: "function_call_output", call_id: m.toolCallId ?? "", output: m.content ?? "" });
        continue;
      }
      if (m.role === "assistant") {
        if (m.content) {
          input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
        }
        for (const tc of m.toolCalls ?? []) {
          input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "" });
        }
        continue;
      }
      // user
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content ?? "" }] });
    }
    return { instructions: instructionParts.length ? instructionParts.join("\n\n") : undefined, input };
  }

  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    const baseUrl = this.config.baseUrl || CODEX_BASE_URL;
    const { instructions, input } = this.buildRequest(messages);
    // The Codex backend only accepts its own model slugs (gpt-5.x / *codex*).
    // Routing can hand us a standard api.openai.com id (e.g. gpt-4.1) as both
    // the requested model AND the configured default, so pick the first
    // Codex-shaped candidate and otherwise fall back to the hardcoded default.
    const model = [options.model, this.config.defaultModel].find(isCodexModel) || DEFAULT_CODEX_MODEL;
    const body: Record<string, any> = {
      model,
      input,
      stream: true,
      store: false,
      ...(instructions ? { instructions } : {}),
    };
    if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
    if (options.tools && options.tools.length > 0) {
      // Responses API tool shape is flat (no nested "function" wrapper).
      body.tools = options.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
    }

    const controller = new AbortController();
    let timedOut = false;
    if (options.abortSignal) {
      if (options.abortSignal.aborted) controller.abort();
      else options.abortSignal.addEventListener("abort", () => controller.abort());
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs) {
      timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          ...codexHeaders(this.config.oauthToken),
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: any) {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) { yield { type: "error", error: { type: "timeout", kind: "timeout", message: "Provider request timed out", retryable: true } }; return; }
      yield { type: "error", error: classifyThrownError(e, options.abortSignal?.aborted ?? false) };
      return;
    }

    if (!response.ok) {
      if (timeoutId) clearTimeout(timeoutId);
      const errText = await response.text().catch(() => "");
      let errMsg = errText || `Request failed with status ${response.status}`;
      try { errMsg = JSON.parse(errText)?.detail || JSON.parse(errText)?.error?.message || errMsg; } catch { /* keep raw */ }
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
    // Map a Responses output-item id -> contiguous tool-call ordinal.
    const itemToOrdinal = new Map<string, number>();
    let nextOrdinal = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let evt: any;
          try { evt = JSON.parse(data); } catch { continue; }

          switch (evt.type) {
            case "response.output_text.delta":
              if (evt.delta) yield { type: "text", text: evt.delta as string };
              break;
            case "response.output_item.added": {
              const item = evt.item;
              if (item?.type === "function_call") {
                const ordinal = nextOrdinal++;
                if (item.id) itemToOrdinal.set(item.id, ordinal);
                yield { type: "tool_call", toolCalls: [{ id: item.call_id || item.id || "", index: ordinal, type: "function", function: { name: item.name || "", arguments: typeof item.arguments === "string" ? item.arguments : "" } }] };
              }
              break;
            }
            case "response.function_call_arguments.delta": {
              const ordinal = (evt.item_id && itemToOrdinal.get(evt.item_id)) ?? 0;
              if (evt.delta) yield { type: "tool_call", toolCalls: [{ id: "", index: ordinal, type: "function", function: { name: "", arguments: evt.delta as string } }] };
              break;
            }
            case "response.completed": {
              const usage = evt.response?.usage;
              if (usage) { promptTokens = usage.input_tokens ?? 0; completionTokens = usage.output_tokens ?? 0; }
              yield { type: "done", usage: { promptTokens, completionTokens } };
              break;
            }
            case "response.incomplete":
              yield { type: "done", usage: { promptTokens, completionTokens } };
              break;
            case "response.failed":
            case "error": {
              const msg = evt.response?.error?.message || evt.error?.message || evt.message || "Codex provider error";
              yield { type: "error", error: { type: "provider_error", kind: "provider", message: msg, retryable: false } };
              return;
            }
            default:
              break;
          }
        }
      }
    } catch (e: any) {
      if (timedOut) { yield { type: "error", error: { type: "timeout", kind: "timeout", message: "Provider stream timed out", retryable: true } }; return; }
      yield { type: "error", error: classifyThrownError(e, options.abortSignal?.aborted ?? false) };
      return;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
