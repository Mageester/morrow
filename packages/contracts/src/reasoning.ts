import type { ReasoningConfiguration, ReasoningMode, RouteReasoningCapability } from "./index.js";

/**
 * The reasoning modes a picker may offer for one exact route, in the
 * provider's own display order.
 *
 * A provider that ships `modes` owns both the ids and their labels, so the UI
 * renders the vendor's vocabulary ("Minimal", "Thinking: high") instead of
 * title-casing an opaque id. A route that reports only `efforts` — a live
 * discovery response, or an older cached row — still yields selectable modes,
 * with the id standing in as its own label.
 *
 * Returning `[]` is meaningful: it says this route exposes no selectable mode,
 * which is what a "none"/"fixed"/"unknown" route must render as. Callers add
 * Auto (and Off, when `supportsOff`) around this list; those are route-level
 * states rather than provider-defined modes, so they are deliberately absent.
 */
export function reasoningModesForRoute(capability: RouteReasoningCapability | undefined): ReasoningMode[] {
  if (!capability) return [];
  if (capability.control !== "effort") return [];
  if (capability.modes && capability.modes.length > 0) {
    // Ids are the contract with translateReasoning; a label-only entry that
    // named no id could never be sent, so the filter is a guard, not a policy.
    return capability.modes.filter((mode) => mode.id.length > 0).map((mode) => ({ ...mode }));
  }
  return capability.efforts.map((id) => ({ id, label: id }));
}

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
      if (config.mode === "off") return capability.supportsOff === true;
      return config.mode === "effort" && capability.efforts.includes(config.effort);
    case "budget":
      return config.mode === "off" || (config.mode === "budget" && (capability.budgets.length === 0 || capability.budgets.includes(config.tokens)));
    case "unknown":
      // Auto is handled above. An unknown route cannot safely accept an
      // explicit reasoning control, even when the provider might accept it.
      return false;
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
