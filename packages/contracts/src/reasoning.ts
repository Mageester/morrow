import type { ReasoningConfiguration, RouteReasoningCapability } from "./index.js";

/**
 * Protocol-agnostic reasoning compatibility. This decides whether a
 * `ReasoningConfiguration` makes sense for a route's *capability* — the
 * question the picker/UI needs ("should this option be selectable/kept?").
 * It is deliberately independent of wire protocol: the orchestrator's
 * `translateReasoning` (services/orchestrator/src/provider/reasoning.ts) is
 * the separate, protocol-aware authority for what actually gets sent over the
 * wire — this function must never be treated as a substitute for it.
 *
 * Single source of truth: both the CLI picker (apps/cli) and the orchestrator
 * (services/orchestrator) import this instead of each re-deriving it.
 */
export function isReasoningCompatible(config: ReasoningConfiguration, capability: RouteReasoningCapability): boolean {
  if (config.mode === "auto") return true; // always valid — provider/route default
  switch (capability.control) {
    case "none":
      return config.mode === "off"; // a no-op, harmless
    case "fixed":
      return config.mode === "provider-fixed";
    case "effort":
      return config.mode === "effort" && capability.efforts.includes(config.effort);
    case "budget":
      return config.mode === "off" || (config.mode === "budget" && (capability.budgets.length === 0 || capability.budgets.includes(config.tokens)));
  }
}

/**
 * Normalize a reasoning config against a route it's moving to. A compatible
 * config passes through unchanged; an incompatible one falls back to Auto
 * (never a silently-wrong setting) — the caller discloses the change.
 */
export function normalizeReasoningForRoute(
  config: ReasoningConfiguration | undefined,
  capability: RouteReasoningCapability
): { config: ReasoningConfiguration; changed: boolean } {
  const current = config ?? { mode: "auto" as const };
  if (isReasoningCompatible(current, capability)) return { config: current, changed: false };
  return { config: { mode: "auto" }, changed: true };
}
