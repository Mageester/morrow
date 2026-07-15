import type { ReasoningConfiguration, RouteReasoningCapability } from "@morrow/contracts";
import { redactSecrets } from "./credentials.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Provider-owned protocol state required to continue a prior response.
   * This is private transport data: never render, log, index, or summarize it. */
  providerContinuation?: ProviderContinuationState;
  /** Internal binding for providerContinuation. Adapters must not serialize it;
   * the execution preflight uses it only to exclude stale state on route changes. */
  providerContinuationRouteFingerprint?: string;
}

export type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content"
  | "mock";

export type ContextLimitSource =
  | "model-metadata"
  | "provider-metadata"
  | "endpoint-override"
  | "fallback"
  | "unknown";

export interface ProviderRouteMetadata {
  providerId: string;
  protocol: ProviderProtocol;
  endpointKind: "default" | "custom" | "injected";
  endpointHost: string | null;
  /** One-way identity of the complete configured base route (scheme, port,
   * path, and query included). Safe to persist; the source URL is not. */
  endpointIdentityHash?: string | null;
  endpointLimitTokens: number | null;
  endpointLimitSource: ContextLimitSource;
}

export interface ProviderContinuationState {
  /** DeepSeek-compatible continuation field. Kept opaque from every public surface. */
  reasoningContent?: string;
  /** Reserved for other provider-required continuation protocol values. */
  opaque?: Record<string, unknown>;
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
  /** Cooldown requested by the provider (parsed Retry-After), in milliseconds. */
  retryAfterMs?: number;
}

export interface ProviderChunk {
  type: "text" | "tool_call" | "done" | "error";
  text?: string;
  toolCalls?: ToolCall[];
  error?: ProviderErrorPayload;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens?: number;
  };
  /** Private provider protocol state; callers must persist it only in the
   * restricted continuation store and must never emit it as a task event. */
  providerContinuation?: ProviderContinuationState;
}

export interface StreamOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  tools?: ToolDefinition[];
  model?: string;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  responseFormat?: "json_object";
  /** Normalized reasoning selection for this request. When present, the adapter
   * translates it (see provider/reasoning.ts) against `reasoningCapability` and
   * merges the resulting params into the wire body — or fails with an
   * invalid-request error for an unsupported combination. Absent means "use the
   * route/provider default". */
  reasoning?: ReasoningConfiguration;
  /** The resolved route's verified reasoning capability, paired with
   * `reasoning` so the adapter validates against real support, never a guess. */
  reasoningCapability?: RouteReasoningCapability;
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
  /** Immutable description of the actual endpoint/protocol this instance calls. */
  readonly route?: ProviderRouteMetadata | undefined;
  streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk>;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  /** Cooldown requested by the provider (parsed Retry-After), in milliseconds. */
  readonly retryAfterMs?: number;
  constructor(
    public type: string,
    message: string,
    options: { kind?: ProviderErrorKind; retryable?: boolean; status?: number; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = options.kind ?? "unknown";
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** Classify an HTTP status code from any provider into a normalized error. */
export function classifyHttpStatus(status: number, message: string, retryAfterMs?: number): ProviderErrorPayload {
  const safeMessage = redactSecrets(message);
  if (status === 401 || status === 403) {
    return { type: "auth_error", kind: "auth", message: safeMessage, retryable: false, status };
  }
  if (status === 429) {
    return {
      type: "rate_limit",
      kind: "rate_limit",
      message: safeMessage,
      retryable: true,
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
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
