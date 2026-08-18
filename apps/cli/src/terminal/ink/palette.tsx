import { Box, Text } from "ink";
import type { Command } from "../commands/registry.js";
import { theme } from "./theme.js";

/**
 * The `/` menu.
 *
 * Bounded to a window that scrolls with the selection. The previous palette
 * rendered every match — with skills installed that was a hundred and twenty
 * rows, which pushed the composer off the screen the instant anyone pressed
 * "/". A menu taller than the terminal is not a menu.
 *
 * Every row is exactly one line. Not by convention — by construction: the name
 * lives in a fixed-width `Box` and the summary truncates. Padding a string and
 * hoping is what produced `/compactsummarise history…`, because a row wide
 * enough to wrap ate its own trailing spaces.
 */

/** Rows visible at once. Deliberately small: this sits above the composer. */
export const PALETTE_ROWS = 8;

export interface Scored {
  command: Command;
  score: number;
}

/**
 * Subsequence match with a score. Higher is better; -1 means no match.
 *
 * Favours, in order: an exact match, an exact prefix, matches at word
 * boundaries, and tightly clustered characters. Deliberately simple and
 * dependency-free — it runs on every keystroke, so predictability matters more
 * than cleverness.
 */
export function fuzzyScore(query: string, target: string): number {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t === q) return 2000;
  if (t.startsWith(q)) return 1000 - t.length;

  let score = 0;
  let cursor = 0;
  let lastHit = -1;
  for (const char of q) {
    const at = t.indexOf(char, cursor);
    if (at === -1) return -1;
    if (at === lastHit + 1) score += 8;
    if (at === 0 || t[at - 1] === "-" || t[at - 1] === "_" || t[at - 1] === ":") score += 6;
    score += 1;
    lastHit = at;
    cursor = at + 1;
  }
  return score - t.length / 10;
}

const isSkill = (command: Command) => command.name.startsWith("skill:");

export function filterCommands(commands: readonly Command[], query: string): Scored[] {
  const trimmed = query.trim();
  if (!trimmed) {
    // Empty query is the browsing case, so the order is the registry's own —
    // grouped by category, most-reached-for first. Skills go last: someone who
    // just pressed "/" is far more likely to want /model than /skill:linting.
    return [...commands]
      .sort((left, right) => Number(isSkill(left)) - Number(isSkill(right)))
      .map((command) => ({ command, score: 0 }));
  }
  return commands
    .map((command) => {
      // A description hit is real but weaker than a name hit: searching "undo"
      // must not rank a command that merely mentions undoing above `/undo`.
      const byName = Math.max(
        fuzzyScore(trimmed, command.name),
        ...(command.aliases ?? []).map((alias) => fuzzyScore(trimmed, alias) - 1),
      );
      const byDescription = fuzzyScore(trimmed, command.summary);
      let score = byName >= 0 ? byName : byDescription >= 0 ? byDescription / 4 : -1;
      // A skill only outranks a built-in on a genuinely strong match. Without
      // this, typing "stat" put seven skills whose descriptions merely contain
      // s-t-a-t above `/changes` — the fuzzy match is technically a match and
      // completely useless.
      if (score >= 0 && isSkill(command) && byName < 1000) score /= 8;
      return { command, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.command.name.localeCompare(right.command.name));
}

/** The window of rows to draw, keeping `selected` inside it. */
export function windowFor(count: number, selected: number, rows = PALETTE_ROWS): { start: number; end: number } {
  if (count <= rows) return { start: 0, end: count };
  const start = Math.min(Math.max(0, selected - Math.floor(rows / 2)), count - rows);
  return { start, end: start + rows };
}

/** The widest name column worth spending, given the terminal. */
function nameColumn(visible: readonly Scored[], width: number): number {
  const longest = Math.max(
    8,
    ...visible.map(({ command }) => command.name.length + 1 + (command.usage ? command.usage.length + 1 : 0)),
  );
  // Never more than half the terminal: a skill with a long argument hint must
  // not squeeze every summary out of view.
  return Math.min(longest, Math.max(12, Math.floor(width / 2)));
}

export interface PaletteProps {
  matches: readonly Scored[];
  selectedIndex: number;
  width: number;
  /** The text being matched, for the empty-state message. */
  query: string;
}

export function CommandPalette({ matches, selectedIndex, width, query }: PaletteProps) {
  if (matches.length === 0) {
    return (
      <Box>
        <Text color={theme.faint}>{`  no command matches "${query}"`}</Text>
      </Box>
    );
  }

  const { start, end } = windowFor(matches.length, selectedIndex);
  const visible = matches.slice(start, end);
  const column = nameColumn(visible, width);
  // +2 keeps a gap between the columns; without it the longest name in the
  // window runs straight into its own summary.
  const summaryWidth = Math.max(8, width - column - 6);

  return (
    <Box flexDirection="column">
      {start > 0 ? <Text color={theme.faint}>{`  ↑ ${start} more`}</Text> : null}
      {visible.map(({ command }, index) => {
        const absolute = start + index;
        const active = absolute === selectedIndex;
        const label = `/${command.name}${command.usage ? ` ${command.usage}` : ""}`;
        return (
          <Box key={command.name} flexDirection="row">
            <Box flexShrink={0} width={2}>
              <Text color={active ? theme.accent : theme.faint}>{active ? "❯ " : "  "}</Text>
            </Box>
            <Box flexShrink={0} width={column + 2}>
              <Text bold={active} color={active ? theme.copy : theme.soft} wrap="truncate-end">
                {label}
              </Text>
            </Box>
            <Box flexShrink={1} width={summaryWidth}>
              <Text color={theme.faint} wrap="truncate-end">
                {command.summary}
              </Text>
            </Box>
          </Box>
        );
      })}
      {matches.length > end ? <Text color={theme.faint}>{`  ↓ ${matches.length - end} more`}</Text> : null}
    </Box>
  );
}
