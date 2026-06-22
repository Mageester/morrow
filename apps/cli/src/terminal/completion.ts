/**
 * Pure completion engine for the slash-command menu.
 *
 * Fuzzy ranking and menu rendering are pure functions so the interactive editor
 * stays a thin I/O shell and the matching behavior is fully unit-testable.
 */
import type { Output } from "../cli/output.js";
import type { SlashCommand } from "./commands.js";

export interface ScoredCommand {
  command: SlashCommand;
  score: number;
}

/**
 * Score how well `query` (already lower-cased, no leading slash) matches a
 * command name. Higher is better. `null` means no match.
 *   - exact name            → best
 *   - prefix match          → strong, shorter names rank higher
 *   - subsequence match     → weak, shorter names rank higher
 */
export function matchScore(query: string, name: string): number | null {
  if (query.length === 0) return 1;
  if (name === query) return 1000;
  if (name.startsWith(query)) return 500 - name.length;
  let qi = 0;
  for (let i = 0; i < name.length && qi < query.length; i++) {
    if (name[i] === query[qi]) qi++;
  }
  return qi === query.length ? 100 - name.length : null;
}

/** Rank commands for the current input. `input` may include the leading slash. */
export function filterCommands(input: string, commands: SlashCommand[]): SlashCommand[] {
  const query = input.replace(/^\//, "").toLowerCase().trim();
  const scored: ScoredCommand[] = [];
  for (const command of commands) {
    const score = matchScore(query, command.name);
    if (score !== null) scored.push({ command, score });
  }
  scored.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
  return scored.map((s) => s.command);
}

export interface MenuOptions {
  selected: number;
  /** Max rows to show. */
  max: number;
  unicode: boolean;
}

/**
 * Render the suggestion menu as lines. The selected row is marked and bolded;
 * names are aligned and descriptions are dimmed. Returns [] when there is
 * nothing to show.
 */
export function renderMenu(matches: SlashCommand[], out: Output, opts: MenuOptions): string[] {
  if (matches.length === 0) return [];
  const pointer = opts.unicode ? "›" : ">";
  const shown = matches.slice(0, opts.max);
  const nameWidth = shown.reduce((w, c) => Math.max(w, c.name.length + (c.arg ? c.arg.length + 1 : 0)), 0);
  const lines = shown.map((c, i) => {
    const selected = i === opts.selected;
    const label = `/${c.name}${c.arg ? " " + c.arg : ""}`.padEnd(nameWidth + 1);
    const mark = selected ? out.cyan(pointer) : " ";
    const name = selected ? out.bold(label) : label;
    return `  ${mark} ${name}  ${out.gray(c.description)}`;
  });
  if (matches.length > shown.length) {
    lines.push(out.gray(`    …${matches.length - shown.length} more`));
  }
  return lines;
}

/** Clamp a selection index into range as the match list changes size. */
export function clampSelection(selected: number, count: number): number {
  if (count <= 0) return 0;
  if (selected < 0) return count - 1;
  if (selected >= count) return 0;
  return selected;
}
