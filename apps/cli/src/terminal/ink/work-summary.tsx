import { Box, Text } from "ink";
import type { ToolCard } from "../state.js";
import { glyphs, theme } from "./theme.js";
import { phrase } from "./tool-verbs.js";

/**
 * The work surface for one turn, in the terminal.
 *
 * Same rule as the web chat: while Morrow is working this is ONE line that
 * updates in place, not a line per tool. The old renderer emitted a card per
 * tool call, so a twenty-tool turn pushed the conversation off the screen
 * before the answer arrived.
 *
 * Repetitive read-only calls collapse into a count. A failure never collapses —
 * it is exactly the row someone is looking for.
 */

/** Tools whose repetition is noise rather than information. */
const GROUPABLE = new Map<string, string>([
  ["read_file", "read"],
  ["list_files", "listed"],
  ["search_text", "searched"],
  ["search_files", "searched"],
  ["search_symbols", "searched"],
  ["git_status", "inspected git"],
  ["git_diff", "inspected git"],
  ["git_log", "inspected git"],
]);

const GROUP_THRESHOLD = 3;

/**
 * Status words the runtime sends in `summary`, which are not descriptions.
 *
 * `tool.completed` arrives with `summary: "completed"` for most tools, so
 * trusting it produced rows that read "✓ completed" — a tick next to the word
 * completed, saying nothing about what was done. These are recognised and
 * discarded so a real label can be composed instead.
 */
const STATUS_WORDS = new Set(["completed", "complete", "ok", "done", "success", "succeeded", "failed", "error"]);


/**
 * What a tool call should say it did.
 *
 * A genuine summary wins. Otherwise the verb and the target are composed —
 * "Read package.json", "Ran pnpm test" — and only if there is neither does the
 * tool's own name appear, humanised.
 */
export function toolLabel(tool: Pick<ToolCard, "name" | "purpose" | "summary">): string {
  const summary = tool.summary?.trim();
  if (summary && !STATUS_WORDS.has(summary.toLowerCase())) return summary;
  return phrase(tool.name, tool.purpose, "past");
}

export interface WorkRow {
  key: string;
  label: string;
  status: ToolCard["status"];
  /** Set when this row stands for several identical calls. */
  count?: number;
  elapsedMs?: number | undefined;
}

/** Collapses a turn's tool cards into the rows worth showing. */
export function workRows(tools: readonly ToolCard[]): WorkRow[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const group = tool.status === "completed" ? GROUPABLE.get(tool.name) : undefined;
    if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
  }

  const rows: WorkRow[] = [];
  const groupAt = new Map<string, number>();
  for (const tool of tools) {
    const group = tool.status === "completed" ? GROUPABLE.get(tool.name) : undefined;
    if (!group || (counts.get(group) ?? 0) < GROUP_THRESHOLD) {
      rows.push({
        key: tool.id,
        label: toolLabel(tool),
        status: tool.status,
        elapsedMs: tool.elapsedMs,
      });
      continue;
    }
    const at = groupAt.get(group);
    if (at === undefined) {
      groupAt.set(group, rows.length);
      rows.push({ key: `group:${group}`, label: `Files ${group}`, status: "completed", count: 1 });
      continue;
    }
    rows[at] = { ...rows[at]!, count: (rows[at]!.count ?? 1) + 1 };
  }
  return rows;
}

function duration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1000) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

export function WorkSummary({
  tools,
  expanded,
  unicode,
  settled = false,
  streaming = false,
}: {
  tools: readonly ToolCard[];
  expanded: boolean;
  unicode: boolean;
  /** True for a finished turn's work, written once into the transcript. It
   *  lists its rows rather than collapsing to a line: the turn is over, so this
   *  is the record of what happened, and Ctrl+O no longer applies to it. */
  settled?: boolean;
  /** True while the turn is still in flight. Without it the collapsed line
   *  claimed a turn was finished the moment no single tool happened to be
   *  mid-flight — which is every second the model spends generating. */
  streaming?: boolean;
}) {
  if (tools.length === 0) return null;
  const g = glyphs(unicode);
  const rows = workRows(tools);
  const failed = tools.some((tool) => tool.status === "failed");

  // Collapsed: one line. This is the default and the point of the component.
  //
  // It reports what this turn has done so far and nothing about what is
  // happening now — `ActivityLine` owns the present tense. That split is why
  // the mark must not be a tick while the turn is still running: a green tick
  // beside "11 tools" is read as a finished turn, and it was rendered on every
  // turn that was still very much in progress.
  if (!expanded && !settled) {
    const mark = failed ? g.fail : streaming ? g.pending : g.done;
    const colour = failed ? theme.danger : streaming ? theme.faint : theme.success;
    const label = `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
    return (
      <Box>
        <Text color={colour}>{mark} </Text>
        <Text color={theme.soft}>{label}</Text>
        <Text color={theme.faint}>  {g.chevron} ctrl+o to expand</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {rows.map((row) => {
        const mark = row.status === "running" ? g.run : row.status === "failed" ? g.fail : g.done;
        const colour =
          row.status === "running" ? theme.accent : row.status === "failed" ? theme.danger : theme.success;
        const elapsed = duration(row.elapsedMs);
        return (
          <Box key={row.key}>
            <Text color={colour}>{mark} </Text>
            <Text color={row.status === "failed" ? theme.danger : theme.soft}>{row.label}</Text>
            {row.count ? <Text color={theme.faint}> · {row.count}</Text> : null}
            {elapsed ? <Text color={theme.faint}> · {elapsed}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
