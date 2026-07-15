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
import type { ModelInfo, ModelStatus, ModelBudgetView, ProviderStatus } from "@morrow/contracts";
import { glyphs } from "./view.js";
import { clampSelection } from "./completion.js";

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

// ── Interactive picker (Claude Code/OpenCode-style overlay) ─────────────────
//
// The static view above stays for the plain, non-interactive `/model`
// fallback (no-TTY sessions and the legacy scripted chat REPL). Everything
// below drives the real interactive overlay: keyboard navigation, search,
// provider grouping, and a live detail panel — all pure and snapshot-
// testable, exactly like the rest of this module.

export interface ModelPickerItem {
  kind: "auto" | "model" | "custom";
  /** The literal value that follows `/model ` when this row is chosen. */
  id: string;
  providerId: string | null;
  label: string;
  /** False only for a real, registry-known model whose provider isn't
   *  configured — never guessed for "auto" or a custom typed id. */
  available: boolean;
  isDefault: boolean;
  status?: ModelStatus;
  /** The canonical resolveModelBudget() view for this model, when the
   *  orchestrator has one. Null (not fabricated) when unavailable. */
  budget?: ModelBudgetView | null;
}

/**
 * Build the picker's real item list: "Auto" (a genuine routing choice, not a
 * fake model) followed by every model the registry knows about. No second,
 * hardcoded model list is ever introduced — `models` and `budgets` both come
 * straight from the orchestrator's canonical registry/ModelBudget.
 */
export function buildModelPickerItems(
  models: ModelStatus[],
  budgets: ModelBudgetView[] = [],
  providers: ProviderStatus[] = []
): ModelPickerItem[] {
  const defaultByProvider = new Map(providers.map((p) => [p.id, p.defaultModel]));
  const items: ModelPickerItem[] = [
    { kind: "auto", id: "auto", providerId: null, label: "Auto — preset routing", available: true, isDefault: false },
  ];
  for (const status of models) {
    const m = status.model;
    const budget = budgets.find((b) => b.providerId === m.providerId && b.selectedModelId === m.id) ?? null;
    items.push({
      kind: "model",
      id: m.id,
      providerId: m.providerId,
      label: m.label,
      available: status.available,
      isDefault: defaultByProvider.get(m.providerId) === m.id,
      status,
      budget,
    });
  }
  return items;
}

function subsequenceScore(query: string, hay: string): number | null {
  if (!query) return 1;
  if (hay === query) return 1000;
  if (hay.startsWith(query)) return 500 - hay.length;
  let qi = 0;
  for (let i = 0; i < hay.length && qi < query.length; i++) if (hay[i] === query[qi]) qi++;
  return qi === query.length ? 100 - hay.length : null;
}

/**
 * Filter + rank items for the current search text. When the typed text
 * doesn't exactly match any known id, a trailing "use as custom model id"
 * row is appended so custom/OpenAI-compatible endpoints — which the built-in
 * registry cannot know about in advance — stay reachable through the picker
 * instead of only through raw `/model <id>` typing.
 */
export function filterModelItems(query: string, items: ModelPickerItem[]): ModelPickerItem[] {
  const q = query.toLowerCase().trim();
  let base: ModelPickerItem[];
  if (!q) {
    base = items.slice();
  } else {
    const scored: Array<{ item: ModelPickerItem; score: number }> = [];
    for (const item of items) {
      const hay = `${item.label} ${item.id} ${item.providerId ?? ""}`.toLowerCase();
      const score = subsequenceScore(q, hay);
      if (score !== null) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    base = scored.map((s) => s.item);
  }
  if (q && !base.some((item) => item.id.toLowerCase() === q)) {
    base.push({
      kind: "custom",
      id: query.trim(),
      providerId: null,
      label: `Use "${query.trim()}" as a custom model id`,
      available: true,
      isDefault: false,
    });
  }
  return base;
}

function priceLabel(m: ModelInfo): string {
  if (!m.pricing) return `cost ${m.costClass}`;
  return `$${m.pricing.inputUsdPerMillion}/$${m.pricing.outputUsdPerMillion} per M tok`;
}

function modelPickerFacts(m: ModelInfo): string {
  const parts = [
    m.speedClass === "unknown" ? "speed unknown" : m.speedClass,
    formatContextWindow(m.contextWindow),
    m.capabilities.toolCalls ? "tools" : "no tools",
    ...(m.capabilities.vision ? ["vision"] : []),
    priceLabel(m),
  ];
  return parts.join("  ·  ");
}

/**
 * The model detail panel (mission spec §2): provider, ids, endpoint/route,
 * context window with an honest confidence label, usable input budget,
 * output reserve, capabilities, pricing, and configuration state. Every
 * number either comes straight from the registry/ModelBudget or is stated as
 * unknown — nothing here is guessed.
 */
export function modelDetailLines(item: ModelPickerItem, out: Output): string[] {
  if (item.kind === "auto") {
    return [
      out.bold("Auto — preset routing"),
      "The active preset chooses provider + model per request; there is no fixed model id.",
      `Change preset preferences with ${out.cyan("/preset")}.`,
    ];
  }
  if (item.kind === "custom") {
    return [
      out.bold(`Custom model id "${item.id}"`),
      "Not in the built-in registry — context window, pricing, and capabilities are unknown until a real response comes back.",
      "Selecting sends requests using this id verbatim to the current provider (OpenAI-compatible custom endpoints supported).",
    ];
  }
  const m = item.status!.model;
  const b = item.budget ?? null;
  const confidence = b?.contextWindowConfidence ?? (m.contextWindow !== null && m.builtIn ? "verified" : "unverified");
  const rows: Array<[string, string]> = [
    ["Provider", m.providerId],
    ["Selected model", m.id],
    ["Canonical id", m.canonicalId],
    ["Endpoint", b ? `${b.protocol}  ·  ${b.endpointKind}${b.endpointHost ? `  ·  ${b.endpointHost}` : ""}` : "unknown"],
    ["Context window", `${formatContextWindow(m.contextWindow)}  (${confidence})`],
    ["Usable input", b ? formatContextWindow(b.usableInputTokens) : "unknown"],
    ["Output reserve", b ? formatContextWindow(b.outputReserveTokens) : "unknown"],
    ["Tool support", m.capabilities.toolCalls ? "yes" : "no"],
    ["Vision support", m.capabilities.vision ? "yes" : "no"],
    ["Pricing", priceLabel(m)],
    ["State", item.available ? "configured & available" : `provider not configured — run \`morrow auth login ${m.providerId}\``],
  ];
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return [out.bold(m.label), ...rows.map(([k, v]) => `${out.gray(k.padEnd(width + 2))}${v}`)];
}

export interface ModelPickerViewOptions {
  query: string;
  selected: number;
  /** Visible list rows before scrolling kicks in — always >= 3. */
  maxRows: number;
  unicode: boolean;
  /** The currently configured model id, or undefined/"auto" for preset routing. */
  currentModelId?: string | undefined;
}

/**
 * Render the interactive picker: search box, a scroll-safe, provider-grouped
 * list (selection stays centered so ↑/↓ always has an on-screen target — the
 * same windowing the slash-completion menu uses), and the highlighted item's
 * detail panel. Pure and snapshot-testable; the caller supplies the already
 * -filtered item list (see `filterModelItems`) so this function never
 * re-derives it.
 */
export function renderModelPicker(items: ModelPickerItem[], out: Output, opts: ModelPickerViewOptions): string[] {
  const g = glyphs(opts.unicode);
  const pointer = opts.unicode ? "›" : ">";
  const currentId = opts.currentModelId ?? "auto";
  const lines: string[] = [];
  lines.push(out.bold("  Select a model") + out.gray("   (type to filter · ↑/↓ move · Enter select · Esc cancel)"));
  lines.push(`  ${out.cyan(">")} ${opts.query}${out.gray("▏")}`);
  lines.push("");

  if (items.length === 0) {
    lines.push(out.gray("    No models available. Connect a provider with ") + out.cyan("morrow auth login") + out.gray("."));
    return lines;
  }

  const maxRows = Math.max(3, opts.maxRows);
  const selected = clampSelection(opts.selected, items.length);
  const start = Math.min(Math.max(0, selected - Math.floor(maxRows / 2)), Math.max(0, items.length - maxRows));
  const shown = items.slice(start, start + maxRows);

  let lastProvider: string | null = null;
  for (const [i, item] of shown.entries()) {
    const idx = start + i;
    const isSelected = idx === selected;
    if (item.kind === "model" && item.providerId !== lastProvider) {
      lines.push(`  ${out.gray(item.providerId!)}`);
      lastProvider = item.providerId;
    } else if (item.kind !== "model") {
      lastProvider = null;
    }

    const marker = isSelected ? out.cyan(pointer) : " ";
    const isCurrent = item.id === currentId;
    const dot = isCurrent ? out.cyan(g.run) : " ";
    let label = item.kind === "model" ? `${item.label}  ${out.gray(item.id)}` : item.label;
    if (item.kind === "model" && !item.available) label = out.gray(label);
    else if (isCurrent) label = out.cyan(label);
    else if (isSelected) label = out.bold(label);

    const tags: string[] = [];
    if (isCurrent) tags.push(out.cyan("current"));
    if (item.isDefault) tags.push(out.gray("default"));
    if (item.kind === "model" && !item.available) tags.push(out.yellow("not configured"));
    const facts = item.kind === "model" ? out.gray(modelPickerFacts(item.status!.model)) : "";
    const tagStr = tags.length ? "  " + tags.join(out.gray(" · ")) : "";
    // Tags (current/default/not-configured) come immediately after the
    // label, before the facts — a width-clipped terminal drops the facts
    // first and never silently swallows a state marker.
    lines.push(`  ${marker}${dot} ${label}${tagStr}${facts ? "  " + facts : ""}`);
  }
  if (items.length > shown.length) {
    lines.push(out.gray(`    …${items.length - shown.length} more — keep scrolling`));
  }

  lines.push("");
  const highlighted = items[selected]!;
  lines.push(`  ${out.gray("─".repeat(4))} detail ${out.gray("─".repeat(4))}`);
  for (const l of modelDetailLines(highlighted, out)) lines.push(`  ${l}`);
  return lines;
}
