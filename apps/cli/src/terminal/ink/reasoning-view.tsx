import { Box, Text } from "ink";
import { glyphs, theme } from "./theme.js";

/**
 * The model's thinking, while it is thinking.
 *
 * Three states, in the order a turn moves through them:
 *
 *   thinking, nothing said yet  — a live tail of the reasoning, dimmed
 *   answering                   — one line: "Thought for 12s"
 *   expanded (Ctrl+R)           — the whole thing
 *
 * It is dimmed and italic throughout, and never carries the assistant's mark.
 * Reasoning is not the answer, and a surface that renders the two alike invites
 * someone to act on a half-formed thought the model then discarded.
 *
 * Only a tail is shown live. Reasoning can run to thousands of words; letting
 * it grow without bound would push the answer — and the composer — off screen,
 * which is the specific failure the work summary already avoids.
 */

/** Live rows before the view starts scrolling with the newest text. */
const LIVE_ROWS = 6;

export interface ReasoningViewProps {
  text: string;
  /** Set once the turn starts answering; collapses the view to a duration. */
  elapsedMs?: number | undefined;
  /** Ctrl+R override — show all of it regardless of state. */
  expanded: boolean;
  unicode: boolean;
  width: number;
}

/**
 * Wrap to width, so the tail is measured in rows a reader sees.
 *
 * On words, not on columns. This used to slice at exactly `width`, which cut
 * every wrapped line mid-word at the terminal edge - the one view in the shell
 * that did not wrap the way the rest of it does. A word longer than the width
 * (a path, a URL) is still broken, because the alternative is a row that
 * overflows its box.
 */
export function rows(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let current = "";
    for (const word of line.split(" ")) {
      if (current === "") current = word;
      else if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
      else {
        out.push(current);
        current = word;
      }
      // A single word wider than the row has to be broken somewhere.
      while (current.length > width) {
        out.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    out.push(current);
  }
  return out;
}

export function formatThinkingTime(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function ReasoningView({ text, elapsedMs, expanded, unicode, width }: ReasoningViewProps) {
  if (!text.trim()) return null;
  const g = glyphs(unicode);
  const inner = Math.max(20, width - 4);
  const settled = elapsedMs !== undefined;

  // Settled and not expanded: one line, and the length is worth stating —
  // "thought for 40s" explains a wait that would otherwise look like a hang.
  if (settled && !expanded) {
    return (
      <Box marginTop={1}>
        <Text color={theme.faint}>{`${g.think} `}</Text>
        <Text color={theme.faint} italic>
          {`Thought for ${formatThinkingTime(elapsedMs)}`}
        </Text>
        <Text color={theme.faint}>{"   ctrl+r to read it"}</Text>
      </Box>
    );
  }

  const all = rows(text.trimEnd(), inner);
  const visible = expanded ? all : all.slice(-LIVE_ROWS);
  const hidden = all.length - visible.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.faint}>{`${g.think} `}</Text>
        <Text color={theme.faint} italic>
          {settled ? `Thought for ${formatThinkingTime(elapsedMs)}` : "Thinking"}
        </Text>
        {hidden > 0 ? <Text color={theme.faint}>{`   ${hidden} earlier lines`}</Text> : null}
        {expanded ? <Text color={theme.faint}>{"   ctrl+r to collapse"}</Text> : null}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {visible.map((line, index) => (
          <Text color={theme.faint} italic key={index}>
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
