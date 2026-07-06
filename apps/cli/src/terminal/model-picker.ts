/**
 * Pure model-picker view: `ModelStatus[]` → `string[]` lines.
 *
 * The picker shows only *known* facts. Anything the model registry cannot
 * assert — a missing context window, an unknown cost class, JSON-mode support
 * (which the CLI cannot observe from the registry) — is labelled "unknown"
 * rather than guessed. This keeps the surface honest: a blank or invented
 * capability is worse than an explicit "unknown".
 *
 * No I/O. Colour/glyphs come from the injected `Output` + `unicode` flag, so the
 * whole picker is snapshot-testable with a no-color `Output`.
 */
import type { Output } from "../cli/output.js";
import type { ModelStatus } from "@morrow/contracts";
import { glyphs } from "./view.js";

export interface ModelSelection {
  provider?: string | undefined;
  model?: string | undefined;
}

/** Human context-window size, or "unknown" when the registry does not know it. */
export function formatContextWindow(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return "unknown";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** Facts line for a single model — only asserts what is actually known. */
export function modelFactsLine(status: ModelStatus, out: Output): string {
  const m = status.model;
  const facts: string[] = [];
  facts.push(m.capabilities.toolCalls ? "tools yes" : "tools no");
  // JSON/structured-output support is not exposed by the model registry, so it
  // is honestly unknown at this layer rather than inferred.
  facts.push("json unknown");
  const ctx = formatContextWindow(m.contextWindow);
  facts.push(`context ${ctx}`);
  facts.push(`cost ${m.costClass}`); // enum already includes "unknown"
  return "      " + out.gray(facts.join("  ·  "));
}

/**
 * Render the interactive model picker. `current` marks the active selection; a
 * bullet (●) precedes the current model. When no explicit model is selected the
 * session is on preset routing ("auto"), which is stated rather than implied.
 */
export function modelPickerLines(
  models: ModelStatus[],
  current: ModelSelection,
  out: Output,
  unicode: boolean
): string[] {
  const g = glyphs(unicode);
  const lines: string[] = [];
  lines.push("  " + out.bold("Models") + out.gray(`  ·  ${g.run} = current  ·  facts shown only when known`));
  if (!current.model) {
    lines.push("  " + out.gray("Selection: ") + out.cyan("auto") + out.gray(" (preset routing chooses the model per request)"));
  }
  lines.push("");

  if (models.length === 0) {
    lines.push("  " + out.yellow("No models available. Connect a provider with ") + out.cyan("morrow auth login") + out.yellow("."));
    return lines;
  }

  for (const status of models) {
    const m = status.model;
    const isCurrent = current.model !== undefined && m.id === current.model;
    const marker = isCurrent ? out.cyan(g.run) : " ";
    const id = isCurrent ? out.cyan(m.id) : out.bold(m.id);
    const avail = status.available ? out.green("available") : out.yellow("unavailable");
    const providerBit = out.gray(m.providerId);
    const currentTag = isCurrent ? out.gray("  · current") : "";
    lines.push(`  ${marker} ${id}  ${providerBit}  ${avail}${currentTag}`);
    lines.push(modelFactsLine(status, out));
  }

  lines.push("");
  lines.push("  " + out.gray("Change with ") + out.cyan("/model <id>") + out.gray(" — your current session is preserved."));
  return lines;
}
