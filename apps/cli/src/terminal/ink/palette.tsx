import { Box, Text } from "ink";
import { groupCommands } from "../command-groups.js";
import type { SlashCommand } from "../commands.js";
import { theme } from "./theme.js";

/**
 * The `/` palette.
 *
 * Fuzzy subsequence matching, because the useful query for `memory-search` is
 * "msearch" and for `checkpoint` is "ckpt". Results stay grouped while the
 * query is empty — that is the browsing case, and a flat alphabetical list is
 * exactly what made seventy-one commands unusable. Once someone types, ranking
 * beats grouping and the list goes flat and ordered by score.
 */

export interface Scored {
  command: SlashCommand;
  score: number;
}

/**
 * Subsequence match with a score. Higher is better; -1 means no match.
 *
 * Scoring favours, in order: an exact prefix, matches at word boundaries, and
 * tightly-clustered characters. This is deliberately simple and dependency-free
 * — it runs on every keystroke against ~71 items, so predictability matters
 * more than cleverness.
 */
export function fuzzyScore(query: string, target: string): number {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;

  let score = 0;
  let cursor = 0;
  let lastHit = -1;
  for (const char of q) {
    const at = t.indexOf(char, cursor);
    if (at === -1) return -1;
    // Adjacent characters are worth more than scattered ones.
    if (at === lastHit + 1) score += 8;
    // A match right after a separator is a word-boundary hit.
    if (at === 0 || t[at - 1] === "-" || t[at - 1] === "_") score += 6;
    score += 1;
    lastHit = at;
    cursor = at + 1;
  }
  return score - t.length / 10;
}

export function filterCommands(commands: readonly SlashCommand[], query: string): Scored[] {
  const trimmed = query.trim();
  if (!trimmed) return commands.map((command) => ({ command, score: 0 }));
  return commands
    .map((command) => {
      // A description hit is real but weaker than a name hit, so it is scored
      // well below one — searching "undo" must not rank a command that merely
      // mentions undoing above `/undo` itself.
      const byName = fuzzyScore(trimmed, command.name);
      const byDescription = fuzzyScore(trimmed, command.description);
      const score = byName >= 0 ? byName : byDescription >= 0 ? byDescription / 4 : -1;
      return { command, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.command.name.localeCompare(right.command.name));
}

/** One row is one line, always. A skill can carry a paragraph-long description
 * and three of them wrapping turns the palette back into a wall. */
function clamp(text: string, max: number): string {
  if (max <= 1) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function Row({
  command,
  selected,
  width,
}: {
  command: SlashCommand;
  selected: boolean;
  width: number;
}) {
  const name = `/${command.name}${command.arg ? ` ${command.arg}` : ""}`;
  // Reserve the marker, the gap, and a little breathing room at the edge.
  const room = Math.max(0, width - name.length - 6);
  const description = clamp(command.description, room);
  return (
    <Box>
      <Text color={selected ? theme.accent : theme.faint}>{selected ? "❯ " : "  "}</Text>
      <Text bold={selected} color={selected ? theme.copy : theme.soft} wrap="truncate">
        {name}
      </Text>
      {description ? (
        <Text color={theme.faint} wrap="truncate">
          {"  "}
          {description}
        </Text>
      ) : null}
    </Box>
  );
}

export function CommandPalette({
  commands,
  query,
  selectedIndex,
  maxRows = 12,
  width = 80,
}: {
  commands: readonly SlashCommand[];
  query: string;
  selectedIndex: number;
  maxRows?: number;
  width?: number;
}) {
  const matches = filterCommands(commands, query);

  if (matches.length === 0) {
    return (
      <Box>
        <Text color={theme.faint}>no command matches “{query}”</Text>
      </Box>
    );
  }

  // Browsing: keep the taxonomy. Searching: ranking wins, so go flat.
  if (!query.trim()) {
    const groups = groupCommands(matches.map((entry) => entry.command));
    let index = 0;
    return (
      <Box flexDirection="column">
        {groups.map((group) => (
          <Box flexDirection="column" key={group.group} marginTop={1}>
            <Text color={theme.faint}>{group.title.toUpperCase()}</Text>
            {group.commands.map((command) => {
              const selected = index++ === selectedIndex;
              return <Row command={command} key={command.name} selected={selected} width={width} />;
            })}
          </Box>
        ))}
      </Box>
    );
  }

  // Keep the selection on screen without redrawing the whole list.
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxRows / 2), matches.length - maxRows));
  const window = matches.slice(Math.max(0, start), Math.max(0, start) + maxRows);

  return (
    <Box flexDirection="column">
      {window.map((entry, offset) => (
        <Row
          command={entry.command}
          key={entry.command.name}
          selected={Math.max(0, start) + offset === selectedIndex}
          width={width}
        />
      ))}
      {matches.length > maxRows ? (
        <Text color={theme.faint}>  {matches.length - maxRows} more…</Text>
      ) : null}
    </Box>
  );
}
