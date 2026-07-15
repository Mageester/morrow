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
import type { ModelInfo, ModelStatus, ModelBudgetView, ProviderStatus, RouteReasoningCapability } from "@morrow/contracts";
import { glyphs } from "./view.js";
import { clampSelection } from "./completion.js";
import { UNKNOWN_REASONING, describeReasoningControl } from "./reasoning.js";

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
  /** The route's reasoning capability with provenance — from the resolved
   *  budget when available, else the registry model, else an explicit
   *  "unknown/none". Never guessed. */
  reasoning: RouteReasoningCapability;
}

/** Reasoning capability for a picker item, honouring metadata precedence
 *  (resolved budget over registry) and falling back to explicit "unknown". */
export function itemReasoning(status?: ModelStatus, budget?: ModelBudgetView | null): RouteReasoningCapability {
  return budget?.reasoning ?? status?.model.reasoning ?? UNKNOWN_REASONING;
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
    { kind: "auto", id: "auto", providerId: null, label: "Auto — preset routing", available: true, isDefault: false, reasoning: UNKNOWN_REASONING },
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
      reasoning: itemReasoning(status, budget),
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
      reasoning: UNKNOWN_REASONING,
    });
  }
  return base;
}

function priceLabel(m: ModelInfo): string {
  if (!m.pricing) return `cost ${m.costClass}`;
  return `$${m.pricing.inputUsdPerMillion}/$${m.pricing.outputUsdPerMillion} per M tok`;
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
  // The budget's resolved window (real ceiling — endpoint override, provider
  // metadata, or model metadata, whichever wins) is authoritative whenever
  // it's available; the static registry value is only a fallback for
  // browsing before a budget has been resolved. Showing the registry number
  // here while Usable input/Output reserve below are already budget-derived
  // would silently disagree with its own confidence label.
  const contextWindowTokens = b ? b.contextWindowTokens : m.contextWindow;
  const rows: Array<[string, string]> = [
    ["Provider", m.providerId],
    ["Selected model", m.id],
    ["Canonical id", m.canonicalId],
    ["Endpoint", b ? `${b.protocol}  ·  ${b.endpointKind}${b.endpointHost ? `  ·  ${b.endpointHost}` : ""}` : "unknown"],
    ["Context window", `${formatContextWindow(contextWindowTokens)}  (${confidence})`],
    ["Usable input", b ? formatContextWindow(b.usableInputTokens) : "unknown"],
    ["Output reserve", b ? formatContextWindow(b.outputReserveTokens) : "unknown"],
    ["Tool support", m.capabilities.toolCalls ? "yes" : "no"],
    ["Vision support", m.capabilities.vision ? "yes" : "no"],
    ["Reasoning", `${describeReasoningControl(item.reasoning)}${item.reasoning.source === "unknown" ? "" : `  (${item.reasoning.source})`}`],
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
 * The compact, highlighted-only detail block (mission spec §1). Claude
 * Code-quality restraint: a model name, its provider + a free/default marker,
 * one facts line (context · tools · reasoning), and the exact route — never a
 * five-tag, table-of-everything "database screen". The full table lives in
 * `modelDetailLines` for `/model current`. Every fact is real or "unknown".
 */
export function modelPickerDetail(item: ModelPickerItem, out: Output): string[] {
  if (item.kind === "auto") {
    return [out.bold("Auto"), out.gray("Preset routing picks provider + model per request · /preset to tune")];
  }
  if (item.kind === "custom") {
    return [out.bold(item.id), out.gray("Custom id · limits, pricing & reasoning unknown until a live response")];
  }
  const m = item.status!.model;
  const b = item.budget ?? null;
  const ctx = formatContextWindow(b ? b.contextWindowTokens : m.contextWindow);
  const free = m.costClass === "free";
  const markers = [
    ...(free ? ["free"] : []),
    ...(item.isDefault ? ["default"] : []),
    ...(item.available ? [] : ["not configured"]),
  ];
  const reasoningWord = item.reasoning.control === "none" ? "no reasoning" : `reasoning: ${item.reasoning.control}`;
  const providerLine = out.gray(`${m.providerId}${markers.length ? " · " + markers.join(" · ") : ""}`);
  const factsLine = out.gray(`${ctx} context · ${m.capabilities.toolCalls ? "tools" : "no tools"} · ${reasoningWord}`);
  const host = b?.endpointHost ? ` · ${b.endpointHost}` : "";
  const routeLine = out.gray(`Route: ${m.providerId}/${m.id}${host}`);
  return [out.bold(m.label), providerLine, factsLine, routeLine];
}

/**
 * Render the interactive picker (mission spec §1): a search box, a scroll-safe
 * list showing only name · provider · state markers, and one compact detail
 * block for the highlighted route. Deliberately minimal — no per-row facts,
 * pricing, or endpoint dumps. Pure and snapshot-testable; the caller supplies
 * the already-filtered item list (see `filterModelItems`).
 */
export function renderModelPicker(items: ModelPickerItem[], out: Output, opts: ModelPickerViewOptions): string[] {
  const g = glyphs(opts.unicode);
  const pointer = opts.unicode ? "›" : ">";
  const currentId = opts.currentModelId ?? "auto";
  const lines: string[] = [];
  lines.push(out.bold("  Select model") + out.gray("   ↑/↓ move · Enter select · Tab reasoning · Esc close"));
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

  for (const [i, item] of shown.entries()) {
    const idx = start + i;
    const isSelected = idx === selected;
    const marker = isSelected ? out.cyan(pointer) : " ";
    const isCurrent = item.id === currentId;
    const dot = isCurrent ? out.cyan(g.run) : " ";

    let label = item.label;
    if (item.kind === "model" && !item.available) label = out.gray(label);
    else if (isCurrent) label = out.cyan(label);
    else if (isSelected) label = out.bold(label);

    // Only the essentials: name, provider/gateway, and state markers. No
    // context/pricing/endpoint noise — that's the highlighted detail block.
    const provider = item.kind === "model" ? out.gray(item.providerId!) : "";
    const tags: string[] = [];
    if (isCurrent) tags.push(out.cyan("current"));
    else if (item.isDefault) tags.push(out.gray("default"));
    if (item.kind === "model" && item.status?.model.costClass === "free") tags.push(out.gray("free"));
    if (item.kind === "model" && !item.available) tags.push(out.yellow("not configured"));
    const tagStr = tags.length ? "  " + tags.join(out.gray(" · ")) : "";
    lines.push(`  ${marker}${dot} ${label}${provider ? "  " + provider : ""}${tagStr}`);
  }
  if (items.length > shown.length) {
    lines.push(out.gray(`    …${items.length - shown.length} more — keep scrolling`));
  }

  lines.push("");
  for (const l of modelPickerDetail(items[selected]!, out)) lines.push(`  ${l}`);
  return lines;
}
