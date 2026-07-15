/**
 * Pure reasoning-control logic + view for the interactive `/reasoning` selector
 * and the `/model` picker's reasoning tab.
 *
 * A route's reasoning is not uniform across providers, so this module derives
 * everything from the route's verified `RouteReasoningCapability` — it never
 * assumes a control a route hasn't declared. Auto is always offered; the other
 * options are exactly what the capability supports, and nothing else. No I/O:
 * colour/glyphs come from the injected `Output`, so it is snapshot-testable.
 */
import type { Output } from "../cli/output.js";
import type { ReasoningConfiguration, RouteReasoningCapability } from "@morrow/contracts";
import { clampSelection } from "./completion.js";

/** An explicit "we know nothing" capability — used when a route omits one. */
export const UNKNOWN_REASONING: RouteReasoningCapability = { control: "none", efforts: [], budgets: [], source: "unknown" };

export interface ReasoningOption {
  /** The command argument this option submits (`auto`, `off`, `low`, `16384`). */
  arg: string;
  label: string;
  config: ReasoningConfiguration;
}

/** Compact human size for a thinking-token budget (2048 → "2k", 16384 → "16k"). */
export function formatBudget(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * The selectable reasoning options for a route. Empty for routes that expose no
 * choice (control "none" → Not configurable, "fixed" → Fixed by provider); the
 * caller renders an informational line for those instead of a list.
 */
export function reasoningOptions(cap: RouteReasoningCapability): ReasoningOption[] {
  const auto: ReasoningOption = { arg: "auto", label: "Auto", config: { mode: "auto" } };
  switch (cap.control) {
    case "none":
    case "fixed":
      return [];
    case "effort":
      return [
        auto,
        ...cap.efforts.map((e): ReasoningOption => ({ arg: e, label: e[0]!.toUpperCase() + e.slice(1), config: { mode: "effort", effort: e } })),
      ];
    case "budget":
      return [
        auto,
        { arg: "off", label: "Off", config: { mode: "off" } },
        ...cap.budgets.map((t): ReasoningOption => ({ arg: String(t), label: formatBudget(t), config: { mode: "budget", tokens: t } })),
      ];
  }
}

/** One-word description of how a route exposes reasoning, for headers/detail. */
export function describeReasoningControl(cap: RouteReasoningCapability): string {
  switch (cap.control) {
    case "none":
      return "Not configurable";
    case "fixed":
      return "Fixed by provider";
    case "effort":
      return "Effort (Low/Medium/High)";
    case "budget":
      return "Thinking-token budget";
  }
}

/** Short label for the active reasoning selection, for the status line/footer. */
export function reasoningStatusText(cfg: ReasoningConfiguration | undefined): string {
  if (!cfg) return "Auto";
  switch (cfg.mode) {
    case "auto":
      return "Auto";
    case "off":
      return "Off";
    case "effort":
      return cfg.effort[0]!.toUpperCase() + cfg.effort.slice(1);
    case "budget":
      return `${formatBudget(cfg.tokens)} thinking`;
    case "provider-fixed":
      return "Fixed";
  }
}

/** Whether a normalized reasoning config is a valid selection for a route. */
export function isReasoningCompatible(cfg: ReasoningConfiguration, cap: RouteReasoningCapability): boolean {
  if (cfg.mode === "auto") return true; // always valid — provider default
  switch (cap.control) {
    case "none":
      return cfg.mode === "off"; // a no-op, harmless
    case "fixed":
      return cfg.mode === "provider-fixed";
    case "effort":
      return cfg.mode === "effort" && cap.efforts.includes(cfg.effort);
    case "budget":
      return cfg.mode === "off" || (cfg.mode === "budget" && (cap.budgets.length === 0 || cap.budgets.includes(cfg.tokens)));
  }
}

/**
 * Normalize a reasoning config against a route it's moving to. Compatible
 * configs pass through unchanged; incompatible ones fall back to Auto (never a
 * silently-wrong setting), reporting the change so the caller can disclose it.
 */
export function normalizeReasoningForRoute(
  cfg: ReasoningConfiguration | undefined,
  cap: RouteReasoningCapability
): { config: ReasoningConfiguration; changed: boolean } {
  const current = cfg ?? { mode: "auto" };
  if (isReasoningCompatible(current, cap)) return { config: current, changed: false };
  return { config: { mode: "auto" }, changed: true };
}

export interface ReasoningPickerOptions {
  selected: number;
  unicode: boolean;
  /** The route these options belong to, for the header (e.g. model label). */
  routeLabel?: string | undefined;
  /** The active reasoning selection, marked with a bullet. */
  current?: ReasoningConfiguration | undefined;
}

function sameConfig(a: ReasoningConfiguration, b: ReasoningConfiguration): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "effort" && b.mode === "effort") return a.effort === b.effort;
  if (a.mode === "budget" && b.mode === "budget") return a.tokens === b.tokens;
  return true;
}

/**
 * Render the reasoning selector overlay. For routes with no adjustable
 * reasoning it shows a single honest state line instead of an empty list.
 */
export function renderReasoningPicker(cap: RouteReasoningCapability, out: Output, opts: ReasoningPickerOptions): string[] {
  const pointer = opts.unicode ? "›" : ">";
  const bullet = opts.unicode ? "●" : "*";
  const lines: string[] = [];
  const header = opts.routeLabel ? `  Reasoning · ${opts.routeLabel}` : "  Reasoning";
  lines.push(out.bold(header) + out.gray("   (↑/↓ move · Enter select · Esc back)"));
  lines.push("");

  const options = reasoningOptions(cap);
  if (options.length === 0) {
    lines.push("  " + out.gray(describeReasoningControl(cap)) + out.gray(` — ${cap.control === "fixed" ? "this model always reasons at a provider-set depth." : "this route has no reasoning controls."}`));
    return lines;
  }

  const selected = clampSelection(opts.selected, options.length);
  for (const [i, opt] of options.entries()) {
    const isSel = i === selected;
    const isCurrent = opts.current !== undefined && sameConfig(opt.config, opts.current);
    const marker = isSel ? out.cyan(pointer) : " ";
    const dot = isCurrent ? out.cyan(bullet) : " ";
    const label = isCurrent ? out.cyan(opt.label) : isSel ? out.bold(opt.label) : opt.label;
    lines.push(`  ${marker}${dot} ${label}`);
  }
  return lines;
}
