import { Box, Text } from "ink";
import { activePastes, layout, type EditorState } from "./editor.js";
import { theme } from "./theme.js";

/**
 * The input line.
 *
 * Draws the editor's own wrapping rather than letting Ink wrap, because the
 * caret has to land on the row the reader sees. `layout()` is the same function
 * the editor uses for up/down movement, so the visible rows and the rows the
 * cursor moves through are the same rows by construction.
 *
 * The caret is drawn, not the terminal's. A real cursor would have to be
 * repositioned after every streamed token, and getting that wrong is how a
 * composer ends up with the caret parked in the middle of the assistant's
 * answer. Inverse video on the character under the caret costs nothing and
 * cannot drift.
 */

/** Rows shown at once before the view scrolls with the caret. */
const MAX_ROWS = 10;

export interface ComposerProps {
  state: EditorState;
  width: number;
  /** Dimmed text shown when the composer is empty. */
  placeholder: string;
  /** Dims the whole composer while a task is running. */
  busy: boolean;
  /** Hides the caret when something else owns the keyboard. */
  focused: boolean;
}

export function Composer({ state, width, placeholder, busy, focused }: ComposerProps) {
  // Two columns for the gutter; the editor already wrapped to this width.
  const inner = Math.max(1, width - 2);
  const view = layout(state.text, state.cursor, inner);

  // Keep the caret in view without ever scrolling a short message.
  const start =
    view.rows.length <= MAX_ROWS
      ? 0
      : Math.min(Math.max(0, view.row - Math.floor(MAX_ROWS / 2)), view.rows.length - MAX_ROWS);
  const visible = view.rows.slice(start, start + MAX_ROWS);
  const hiddenAbove = start;
  const hiddenBelow = view.rows.length - (start + visible.length);

  const empty = state.text.length === 0;
  const held = activePastes(state).length;
  const marker = busy ? theme.faint : theme.accent;

  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 ? (
        <Text color={theme.faint}>{`  ↑ ${hiddenAbove} more line${hiddenAbove === 1 ? "" : "s"}`}</Text>
      ) : null}

      {visible.map((row, index) => {
        const absolute = start + index;
        const isCaretRow = focused && absolute === view.row;
        const gutter = absolute === 0 ? "> " : "  ";
        if (!isCaretRow) {
          return (
            <Box key={absolute}>
              <Text color={marker}>{gutter}</Text>
              <Text color={busy ? theme.soft : theme.copy}>{row}</Text>
            </Box>
          );
        }
        const before = row.slice(0, view.column);
        const at = row.slice(view.column, view.column + 1) || " ";
        const after = row.slice(view.column + 1);
        return (
          <Box key={absolute}>
            <Text color={marker}>{gutter}</Text>
            <Text color={busy ? theme.soft : theme.copy}>{before}</Text>
            <Text inverse color={busy ? theme.soft : theme.copy}>
              {at}
            </Text>
            <Text color={busy ? theme.soft : theme.copy}>{after}</Text>
            {empty ? <Text color={theme.faint}>{placeholder}</Text> : null}
          </Box>
        );
      })}

      {hiddenBelow > 0 ? (
        <Text color={theme.faint}>{`  ↓ ${hiddenBelow} more line${hiddenBelow === 1 ? "" : "s"}`}</Text>
      ) : null}

      {held > 0 ? (
        <Text color={theme.faint}>
          {`  ${held} pasted block${held === 1 ? "" : "s"} held — sent in full`}
        </Text>
      ) : null}
    </Box>
  );
}
