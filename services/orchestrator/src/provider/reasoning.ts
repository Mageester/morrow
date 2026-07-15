import type { ReasoningConfiguration, RouteReasoningCapability } from "@morrow/contracts";
import type { ProviderProtocol } from "./base.js";

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

export function translateReasoning(
  config: ReasoningConfiguration,
  protocol: ProviderProtocol,
  capability: RouteReasoningCapability
): ReasoningTranslation {
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
      if (config.mode !== "effort") {
        return { ok: false, reason: "This route configures reasoning by effort level (Low/Medium/High), not this mode." };
      }
      if (!capability.efforts.includes(config.effort)) {
        return { ok: false, reason: `Unsupported reasoning effort "${config.effort}" for this route.` };
      }
      if (!isOpenAiFamily(protocol)) {
        return { ok: false, reason: "Effort-based reasoning is not supported on this provider protocol." };
      }
      return { ok: true, params: { reasoning_effort: config.effort } };

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
  }
}
