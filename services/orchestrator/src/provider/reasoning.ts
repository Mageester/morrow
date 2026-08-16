import type { ReasoningConfiguration, ReasoningWire, RouteReasoningCapability } from "@morrow/contracts";
import { reasoningModesForRoute } from "@morrow/contracts";
import type { ProviderProtocol } from "./base.js";
import type { ReasoningCapability } from "./model-capabilities.js";

/**
 * Reasoning is not a uniform API across providers. This module is the single
 * place that turns Morrow's normalized `ReasoningConfiguration` into the exact
 * request parameters a given provider protocol understands — or rejects the
 * combination with a clear, user-facing explanation *before* any request is
 * issued. Nothing here guesses: a route only accepts a mode its verified
 * `RouteReasoningCapability` actually supports.
 *
 * Adapters call this once per request and either merge `params` into the wire
 * body or surface `reason` as an invalid-request error.
 */
export type ReasoningTranslation =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; reason: string };

/** Whether a protocol carries OpenAI-style `reasoning_effort`. */
function isOpenAiFamily(protocol: ProviderProtocol): boolean {
  return protocol === "openai-chat" || protocol === "openai-responses";
}

/**
 * The dialect a route most likely speaks when it declared none.
 *
 * This is a fallback for capability rows written before dialects existed, not
 * the resolution path: a provider that ships capability metadata always names
 * its own dialect, and a protocol with no obvious spelling stays undecided
 * rather than being handed OpenAI's.
 */
function inferWireDialect(protocol: ProviderProtocol): ReasoningWire | undefined {
  if (isOpenAiFamily(protocol)) return "openai-reasoning-effort";
  if (protocol === "gemini-generate-content") return "gemini-thinking-level";
  if (protocol === "anthropic-messages") return "anthropic-thinking-budget";
  return undefined;
}

function isExactCapability(capability: RouteReasoningCapability | ReasoningCapability): capability is ReasoningCapability {
  return "mode" in capability;
}

/**
 * True when the route's wire protocol requires the assistant's own reasoning
 * output to be echoed back in the history of every subsequent request that has
 * reasoning enabled.
 *
 * This is a protocol fact about the wire format, not a judgement about any
 * model. DeepSeek's thinking mode rejects a request outright ("The
 * `reasoning_content` in the thinking mode must be passed back to the API")
 * when the preceding assistant turn carries none — which is exactly what
 * happens after a recovery turn deliberately ran with thinking disabled.
 * Callers use this to keep such a conversation on a protocol-valid path
 * instead of producing a request the route must reject.
 */
export function reasoningRequiresEchoedContent(
  capability: RouteReasoningCapability | ReasoningCapability | undefined,
): boolean {
  return capability?.wire === "deepseek-thinking";
}

/**
 * Whether this request must run with reasoning disabled purely to stay
 * protocol-valid, because the route echoes reasoning back and the newest
 * assistant turn in the history has none.
 *
 * Returns false when the route cannot disable reasoning at all: there is no
 * safe request to build in that case, and silently pretending otherwise would
 * hide the real provider error.
 */
export function suppressReasoningForEchoContinuity(input: {
  capability: RouteReasoningCapability | ReasoningCapability | undefined;
  /** Absent means there is no prior assistant turn to echo. */
  lastAssistantHasReasoning: boolean | undefined;
  supportsOff: boolean;
}): boolean {
  if (input.lastAssistantHasReasoning !== false) return false;
  if (!input.supportsOff) return false;
  return reasoningRequiresEchoedContent(input.capability);
}

function translateExactReasoning(
  config: ReasoningConfiguration,
  protocol: ProviderProtocol,
  capability: ReasoningCapability,
): ReasoningTranslation {
  if (config.mode === "auto") return { ok: true, params: {} };
  const disable = (): ReasoningTranslation => {
    if (capability.supportsOff !== true) {
      return { ok: false, reason: "This exact route does not report that reasoning can be disabled." };
    }
    return capability.wire === "deepseek-thinking"
      ? { ok: true, params: { thinking: { type: "disabled" } } }
      : protocol === "anthropic-messages"
        ? { ok: true, params: { thinking: { type: "disabled" } } }
        : { ok: true, params: {} };
  };

  switch (capability.mode) {
    case "unknown":
      return { ok: false, reason: "This route has not reported a reasoning capability; choose Auto or configure the provider metadata first." };
    case "none":
      return config.mode === "off"
        ? { ok: true, params: {} }
        : { ok: false, reason: "This exact route does not expose reasoning controls." };
    case "fixed":
      if (config.mode === "provider-fixed") return { ok: true, params: {} };
      if (config.mode === "off") return disable();
      return { ok: false, reason: "This exact route reports fixed reasoning and cannot be tuned." };
    case "selectable": {
      if (config.mode === "off") return disable();
      if (config.mode !== "effort") return { ok: false, reason: "This exact route configures reasoning with an opaque effort selector." };
      // The selected mode must be one the route declared. Its id is opaque —
      // matching it against a core enum here is exactly the global
      // low/medium/high assumption this system exists to remove.
      const selected = capability.efforts.find((effort) => effort.id === config.effort);
      if (!selected) return { ok: false, reason: `Unsupported reasoning effort "${config.effort}" for this exact route.` };
      const wireValue = selected.wireValue ?? selected.id;
      // Dispatch on the provider-declared dialect. A route that declared none
      // falls back to inferring one from the protocol, which is what keeps
      // older cached capability rows working.
      switch (capability.wire ?? inferWireDialect(protocol)) {
        case "deepseek-thinking":
          return { ok: true, params: { reasoning_effort: wireValue, thinking: { type: "enabled" } } };
        case "openai-reasoning-effort":
          return { ok: true, params: { reasoning_effort: wireValue } };
        case "gemini-thinking-level":
          return { ok: true, params: { thinkingConfig: { thinkingLevel: wireValue } } };
        case "anthropic-thinking-budget": {
          // This dialect spends thinking tokens, so an effort mode only reaches
          // the wire when the provider declared the budget it stands for. A
          // bare level has nothing to send, which is the same outcome as the
          // protocol not offering effort selection at all.
          const tokens = Number(wireValue);
          if (!Number.isSafeInteger(tokens) || tokens <= 0) {
            return { ok: false, reason: "Effort-based reasoning is not supported on this provider protocol." };
          }
          return { ok: true, params: { thinking: { type: "enabled", budget_tokens: tokens } } };
        }
        default:
          return { ok: false, reason: "This exact route does not expose an effort wire field for this protocol." };
      }
    }
    case "budget": {
      if (config.mode === "off") return disable();
      if (config.mode !== "budget") return { ok: false, reason: "This exact route configures reasoning with a token budget." };
      if (capability.efforts.length > 0 && !capability.efforts.some((effort) => effort.id === String(config.tokens) || effort.wireValue === String(config.tokens))) {
        return { ok: false, reason: `Unsupported reasoning budget ${config.tokens} tokens for this exact route.` };
      }
      if (protocol !== "anthropic-messages") return { ok: false, reason: "Token-budget reasoning is not supported on this provider protocol." };
      return { ok: true, params: { thinking: { type: "enabled", budget_tokens: config.tokens } } };
    }
  }
}

export function translateReasoning(
  config: ReasoningConfiguration,
  protocol: ProviderProtocol,
  capability: RouteReasoningCapability | ReasoningCapability
): ReasoningTranslation {
  if (isExactCapability(capability)) return translateExactReasoning(config, protocol, capability);
  // "auto" always means: send no explicit reasoning params and let the route's
  // own default (preset/provider) stand. Valid on every route.
  if (config.mode === "auto") return { ok: true, params: {} };

  switch (capability.control) {
    case "none":
      // Nothing to configure. "off" is a harmless no-op (already off); any
      // active request is a category error the caller should never construct.
      if (config.mode === "off") return { ok: true, params: {} };
      return { ok: false, reason: "This route does not expose reasoning controls." };

    case "fixed":
      // The provider fixes the reasoning depth; it cannot be tuned or disabled.
      if (config.mode === "provider-fixed") return { ok: true, params: {} };
      if (config.mode === "off") return { ok: false, reason: "This model always reasons; its depth is fixed by the provider and cannot be turned off." };
      return { ok: false, reason: "This model's reasoning is fixed by the provider and cannot be tuned." };

    case "effort":
      if (config.mode === "off") {
        if (!capability.supportsOff) {
          return { ok: false, reason: "This model exposes effort control but does not support disabling reasoning." };
        }
        return {
          ok: true,
          params: capability.wire === "deepseek-thinking" ? { thinking: { type: "disabled" } } : {},
        };
      }
      if (config.mode !== "effort") {
        return { ok: false, reason: "This route configures reasoning by an effort selector, not this mode." };
      }
      if (!capability.efforts.includes(config.effort)) {
        return { ok: false, reason: `Unsupported reasoning effort "${config.effort}" for this route.` };
      }
      // Same dialect dispatch as the exact path, reading the same
      // provider-declared wire spelling, so the two cannot disagree about what
      // a given selection sends.
      return translateExactReasoning(config, protocol, {
        mode: "selectable",
        efforts: reasoningModesForRoute(capability).map((mode) => ({
          id: mode.id,
          label: mode.label,
          ...(mode.wireValue === undefined ? {} : { wireValue: mode.wireValue }),
        })),
        ...(capability.supportsOff === undefined ? {} : { supportsOff: capability.supportsOff }),
        ...(capability.wire === undefined ? {} : { wire: capability.wire }),
      });

    case "budget":
      if (config.mode === "off") {
        // Explicitly disable thinking where the protocol supports it.
        return protocol === "anthropic-messages"
          ? { ok: true, params: { thinking: { type: "disabled" } } }
          : { ok: true, params: {} };
      }
      if (config.mode !== "budget") {
        return { ok: false, reason: "This route configures reasoning by a thinking-token budget, not this mode." };
      }
      if (capability.budgets.length > 0 && !capability.budgets.includes(config.tokens)) {
        return { ok: false, reason: `Unsupported reasoning budget ${config.tokens} tokens for this route.` };
      }
      if (protocol !== "anthropic-messages") {
        return { ok: false, reason: "Token-budget reasoning is not supported on this provider protocol." };
      }
      return { ok: true, params: { thinking: { type: "enabled", budget_tokens: config.tokens } } };

    case "unknown":
      return { ok: false, reason: "This route has not reported a reasoning capability; choose Auto or configure the provider metadata first." };
  }
}
