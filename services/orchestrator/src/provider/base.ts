import { redactSecrets } from "./credentials.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  index?: number;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * Normalized error classification shared by every provider adapter. The agent
 * runtime uses `kind` to decide whether a failure is safe to retry without
 * surfacing provider-specific wire formats.
 */
export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "cancelled"
  | "invalid_request"
  | "provider"
  | "unknown";

export interface ProviderErrorPayload {
  type: string;
  kind: ProviderErrorKind;
  message: string;
  retryable: boolean;
  status?: number;
}

export interface ProviderChunk {
  type: "text" | "tool_call" | "done" | "error";
  text?: string;
  toolCalls?: ToolCall[];
  error?: ProviderErrorPayload;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface StreamOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  tools?: ToolDefinition[];
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  temperature?: number | null;
  maxOutputTokens?: number | null;
}

/** Capability flags surfaced to the UI and used by the router. */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  systemMessages: boolean;
  vision: boolean;
  customEndpoint: boolean;
  local: boolean;
}

export interface ProviderMetadata {
  id: string;
  label: string;
  capabilities: ProviderCapabilities;
}

export interface AiProvider {
  /** Stable provider identifier (e.g. "openai", "anthropic"). */
  readonly id?: string;
  streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk>;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(
    public type: string,
    message: string,
    options: { kind?: ProviderErrorKind; retryable?: boolean; status?: number } = {}
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = options.kind ?? "unknown";
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** Classify an HTTP status code from any provider into a normalized error. */
export function classifyHttpStatus(status: number, message: string): ProviderErrorPayload {
  const safeMessage = redactSecrets(message);
  if (status === 401 || status === 403) {
    return { type: "auth_error", kind: "auth", message: safeMessage, retryable: false, status };
  }
  if (status === 429) {
    return { type: "rate_limit", kind: "rate_limit", message: safeMessage, retryable: true, status };
  }
  if (status === 400 || status === 404 || status === 422) {
    return { type: "invalid_request", kind: "invalid_request", message: safeMessage, retryable: false, status };
  }
  if (status >= 500) {
    return { type: "provider_error", kind: "provider", message: safeMessage, retryable: true, status };
  }
  return { type: "provider_error", kind: "provider", message: safeMessage, retryable: false, status };
}

/** Translate a thrown fetch/abort error into a normalized provider error payload. */
export function classifyThrownError(e: any, aborted: boolean): ProviderErrorPayload {
  if (aborted || e?.name === "AbortError") {
    return { type: "cancelled", kind: "cancelled", message: "Request cancelled", retryable: false };
  }
  return {
    type: "network_error",
    kind: "network",
    message: redactSecrets(e?.message || "Network request failed"),
    retryable: true,
  };
}
