/**
 * Command-palette items and fuzzy search.
 *
 * Every palette item resolves to a slash-command line (`run`) so selecting one
 * is just "submit this command" — commands, mode switches, model/provider/
 * project/session picks all flow through the same dispatch path. Items beyond
 * the static command list (models, projects, sessions) are supplied by the
 * session controller from real data sources; this module never invents records.
 */
import type { Output } from "../cli/output.js";
import type { SlashCommand } from "./commands.js";
import { matchScore } from "./completion.js";

export type PaletteKind = "command" | "mode" | "model" | "project" | "session" | "task";

export interface PaletteItem {
  kind: PaletteKind;
  label: string;
  hint?: string;
  /** The slash-command line executed when this item is chosen. */
  run: string;
}

const KIND_LABEL: Record<PaletteKind, string> = {
  command: "cmd",
  mode: "mode",
  model: "model",
  project: "proj",
  session: "sess",
  task: "task",
};

/** Static items always available: the slash commands and the capability modes. */
export function staticPaletteItems(commands: SlashCommand[]): PaletteItem[] {
  const commandItems: PaletteItem[] = commands.map((c) => ({
    kind: "command",
    label: `/${c.name}${c.arg ? " " + c.arg : ""}`,
    hint: c.description,
    run: `/${c.name}`,
  }));
  const modeItems: PaletteItem[] = [
    { kind: "mode", label: "Ask mode", hint: "explain & inspect · no changes", run: "/mode ask" },
    { kind: "mode", label: "Plan mode", hint: "produce a plan · no changes", run: "/mode plan" },
    { kind: "mode", label: "Build mode", hint: "edit files & run tools · approval-gated", run: "/mode build" },
    { kind: "mode", label: "Mission", hint: "verified autonomous objective", run: "/mode mission" },
    { kind: "mode", label: "YOLO on", hint: "auto-approve edits & commands", run: "/yolo on" },
    { kind: "mode", label: "YOLO off", hint: "require approvals", run: "/yolo off" },
  ];
  return [...commandItems, ...modeItems];
}

/** Fuzzy-rank palette items by label (and kind keyword). */
export function fuzzyPalette(query: string, items: PaletteItem[]): PaletteItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  const scored: Array<{ item: PaletteItem; score: number }> = [];
  for (const item of items) {
    const hay = `${item.label} ${KIND_LABEL[item.kind]} ${item.hint ?? ""}`.toLowerCase();
    const score = subsequenceScore(q, hay);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** Looser than command matching: matches anywhere as a subsequence, prefix-boosted. */
function subsequenceScore(query: string, hay: string): number | null {
  // Reuse the exact/prefix tiers against the first token, then fall back to a
  // whole-haystack subsequence test.
  const firstToken = hay.split(/\s+/)[0] ?? "";
  const direct = matchScore(query, firstToken.replace(/^\//, ""));
  if (direct !== null) return 1000 + direct;
  let qi = 0;
  for (let i = 0; i < hay.length && qi < query.length; i++) {
    if (hay[i] === query[qi]) qi++;
  }
  return qi === query.length ? 100 - hay.length : null;
}

export interface PaletteViewOptions {
  query: string;
  selected: number;
  max: number;
  unicode: boolean;
  columns: number;
}

/** Render the palette overlay as lines (title, query, results). */
export function renderPalette(items: PaletteItem[], out: Output, opts: PaletteViewOptions): string[] {
  const pointer = opts.unicode ? "›" : ">";
  const lines: string[] = [];
  lines.push(out.bold("  Command palette") + out.gray("   (type to filter · Enter to run · Esc to close)"));
  lines.push(`  ${out.cyan(">")} ${opts.query}${out.gray("▏")}`);
  const shown = items.slice(0, opts.max);
  if (shown.length === 0) {
    lines.push(out.gray("    no matches"));
  }
  const labelWidth = shown.reduce((w, it) => Math.max(w, it.label.length), 0);
  for (const [i, it] of shown.entries()) {
    const selected = i === opts.selected;
    const mark = selected ? out.cyan(pointer) : " ";
    const kind = out.gray(`[${KIND_LABEL[it.kind]}]`);
    const label = selected ? out.bold(it.label.padEnd(labelWidth)) : it.label.padEnd(labelWidth);
    const hint = it.hint ? out.gray("  " + it.hint) : "";
    lines.push(`  ${mark} ${kind} ${label}${hint}`);
  }
  if (items.length > shown.length) lines.push(out.gray(`    …${items.length - shown.length} more`));
  return lines;
}
