import type { MaxOutputTokensField, ModelRequestCapabilities, RouteReasoningCapability } from "@morrow/contracts";
import type { ProviderProtocol } from "../provider/base.js";

export const UNKNOWN_REQUEST_CAPABILITIES: ModelRequestCapabilities = {
  tools: "unknown",
  toolChoice: "unknown",
  temperature: "unknown",
  streamUsage: "unknown",
  responseFormat: "unknown",
  maxOutputTokens: "unknown",
};

const SUPPORTED = "supported" as const;
const UNSUPPORTED = "unsupported" as const;

/**
 * The protocol baseline is deliberately about the adapter's wire shape, not
 * a claim that every model behind that protocol accepts every field. A
 * model-reported profile is merged over this baseline; an unknown model gets
 * the explicit unknown profile instead (see models.ts).
 */
export function protocolRequestCapabilities(protocol: ProviderProtocol): ModelRequestCapabilities {
  switch (protocol) {
    case "anthropic-messages":
      return {
        tools: SUPPORTED,
        toolChoice: SUPPORTED,
        temperature: SUPPORTED,
        streamUsage: UNSUPPORTED,
        responseFormat: UNSUPPORTED,
        maxOutputTokens: "max_tokens",
      };
    case "gemini-generate-content":
      return {
        tools: SUPPORTED,
        toolChoice: UNSUPPORTED,
        temperature: SUPPORTED,
        streamUsage: UNSUPPORTED,
        responseFormat: UNSUPPORTED,
        maxOutputTokens: "max_output_tokens",
      };
    case "openai-responses":
      return {
        tools: SUPPORTED,
        toolChoice: SUPPORTED,
        temperature: SUPPORTED,
        streamUsage: UNSUPPORTED,
        responseFormat: UNSUPPORTED,
        maxOutputTokens: "max_output_tokens",
      };
    case "openai-chat":
      return {
        tools: SUPPORTED,
        toolChoice: SUPPORTED,
        temperature: SUPPORTED,
        streamUsage: SUPPORTED,
        responseFormat: SUPPORTED,
        maxOutputTokens: "max_tokens",
      };
    case "mock":
      return {
        tools: SUPPORTED,
        toolChoice: SUPPORTED,
        temperature: SUPPORTED,
        streamUsage: SUPPORTED,
        responseFormat: SUPPORTED,
        maxOutputTokens: "max_tokens",
      };
    default:
      return { ...UNKNOWN_REQUEST_CAPABILITIES };
  }
}

/** Merge an explicitly reported profile. Absence of a profile means silence
 * and is handled by the caller; an explicit "unknown" field is itself a fact
 * that must not be replaced with a guessed protocol default. */
export function mergeRequestCapabilities(
  base: ModelRequestCapabilities,
  override: Partial<ModelRequestCapabilities> | undefined,
): ModelRequestCapabilities {
  if (!override) return { ...base };
  return {
    ...base,
    ...override,
  };
}

/**
 * Normalize OpenAI-compatible `supported_parameters` metadata. A non-empty
 * list is authoritative for named optional fields: if `temperature` is not
 * listed, Morrow must not keep sending it merely because another gateway did.
 * Fields the catalogue cannot identify remain unknown rather than guessed.
 */
export function requestCapabilitiesFromSupportedParameters(
  parameters: readonly string[] | undefined,
): ModelRequestCapabilities {
  const normalized = (parameters ?? [])
    .map((value) => value.trim().toLowerCase().replace(/-/g, "_"))
    .filter(Boolean);
  if (normalized.length === 0) return { ...UNKNOWN_REQUEST_CAPABILITIES };
  const has = (...names: string[]) => names.some((name) => normalized.includes(name));
  const maxOutputTokens: MaxOutputTokensField = has("max_output_tokens")
    ? "max_output_tokens"
    : has("max_completion_tokens")
      ? "max_completion_tokens"
      : has("max_tokens")
        ? "max_tokens"
        : "unknown";
  return {
    tools: has("tools", "tool_calls", "functions") ? SUPPORTED : UNSUPPORTED,
    toolChoice: has("tool_choice", "function_call") ? SUPPORTED : UNSUPPORTED,
    temperature: has("temperature") ? SUPPORTED : UNSUPPORTED,
    streamUsage: has("stream_options", "include_usage", "usage") ? SUPPORTED : UNSUPPORTED,
    responseFormat: has("response_format", "structured_outputs", "json_schema") ? SUPPORTED : UNSUPPORTED,
    maxOutputTokens,
  };
}

/**
 * Translate provider-reported reasoning parameters into the normalized route
 * contract. A boolean `reasoning: true` without a named control is fixed, not
 * guessed as effort-based; only an explicit `reasoning_effort` parameter earns
 * an effort picker.
 */
export function reasoningCapabilityFromSupportedParameters(
  parameters: readonly string[] | undefined,
): RouteReasoningCapability | undefined {
  const normalized = (parameters ?? [])
    .map((value) => value.trim().toLowerCase().replace(/-/g, "_"))
    .filter(Boolean);
  if (normalized.length === 0) return undefined;
  const has = (...names: string[]) => names.some((name) => normalized.includes(name));
  if (has("reasoning_effort")) {
    return {
      control: "effort",
      efforts: ["low", "medium", "high"],
      budgets: [],
      source: "provider-metadata",
      ...(has("thinking", "reasoning_off", "disable_thinking") ? { supportsOff: true } : {}),
      ...(has("thinking") ? { wire: "deepseek-thinking" as const } : {}),
    };
  }
  if (has("reasoning", "include_reasoning", "thinking")) {
    return {
      control: "fixed",
      efforts: [],
      budgets: [],
      source: "provider-metadata",
      ...(has("thinking", "reasoning_off", "disable_thinking") ? { supportsOff: true } : {}),
      ...(has("thinking") ? { wire: "deepseek-thinking" as const } : {}),
    };
  }
  return undefined;
}
