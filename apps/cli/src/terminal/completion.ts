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
  if (query.length === 1 && name.length <= 3 && name.startsWith(query)) return 450 - name.length;
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

/**
 * Return completion candidates for a slash command or its first subcommand.
 * Candidate names remain slash-ready (for example, `mode build`) so the input
 * controller can use one insertion path for both levels.
 */
export function completionCandidates(input: string, commands: SlashCommand[]): SlashCommand[] {
  const parsed = input.match(/^\/([^\s]*)(?:\s+(.*))?$/s);
  if (!parsed) return [];
  const [, rootQuery, argQuery] = parsed;
  if (argQuery === undefined) return filterCommands(input, commands);

  const root = commands.find((command) => command.name.toLowerCase() === rootQuery!.toLowerCase());
  if (!root?.subcommands?.length || /\s/.test(argQuery.trim())) return [];
  const query = argQuery.trim().toLowerCase();
  return root.subcommands
    .map((subcommand) => ({ subcommand, score: matchScore(query, subcommand.toLowerCase()) }))
    .filter((item): item is { subcommand: string; score: number } => item.score !== null)
    .sort((a, b) => b.score - a.score || a.subcommand.localeCompare(b.subcommand))
    .map(({ subcommand }) => ({ name: `${root.name} ${subcommand}`, description: root.description }));
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
  const selected = clampSelection(opts.selected, matches.length);
  // Selection can move through every match, not merely the first visible page.
  // Keep it near the middle of the menu so ↑/↓ always has an on-screen target.
  const start = Math.min(
    Math.max(0, selected - Math.floor(opts.max / 2)),
    Math.max(0, matches.length - opts.max),
  );
  const shown = matches.slice(start, start + opts.max);
  const nameWidth = shown.reduce((w, c) => Math.max(w, c.name.length + (c.arg ? c.arg.length + 1 : 0)), 0);
  const lines = shown.map((c, i) => {
    const isSelected = start + i === selected;
    const label = `/${c.name}${c.arg ? " " + c.arg : ""}`.padEnd(nameWidth + 1);
    const mark = isSelected ? out.cyan(pointer) : " ";
    const name = isSelected ? out.bold(label) : label;
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
