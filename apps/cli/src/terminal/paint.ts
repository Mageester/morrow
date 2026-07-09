/**
 * Raw ANSI sequence assembly for a full-frame terminal repaint. Shared by
 * `InteractiveSession` (the live REPL) and `InteractiveRenderer` (the Phase-1
 * MORROW_TUI=1 renderer) so the two paint loops can't drift onto different
 * (and differently buggy) escape-sequence orderings.
 */
const CURSOR_HOME = "\x1b[H";
const CLEAR_EOL = "\x1b[K";
const CLEAR_BELOW = "\x1b[J";

/**
 * Build the write for one repaint: clear-then-write per line, plus a bounded
 * clear of any stale rows left over from a taller previous frame.
 *
 * Clearing *before* writing (not after) matters: a line that fills the
 * terminal to the exact last column leaves the cursor in the terminal's
 * deferred-wrap state — logically still sitting on that last column, not yet
 * advanced. "Erase cursor to end of line" (`\x1b[K`) is inclusive of the
 * cursor's cell, so erasing right after such a line silently deletes the
 * character it just painted (in practice, the trailing "…" from
 * `clipToWidth`). Erasing first, while the cursor sits at a fresh column 1,
 * has no such ambiguity.
 *
 * Stale trailing rows (frame shrank since the last paint) are cleared with
 * an absolute cursor position — `\x1b[<row>;1H` — rather than a bare `\r\n`
 * (which scrolls the viewport if the prior last line sat on the bottom row)
 * or an erase chained straight off the last line's content (which would hit
 * the same deferred-wrap trap as above).
 */
export function composePaintBody(lines: readonly string[], previousFrameRows: number): string {
  const body = lines.map((l) => CLEAR_EOL + l).join("\r\n");
  let out = CURSOR_HOME + body;
  if (lines.length < previousFrameRows) {
    out += `\x1b[${lines.length + 1};1H` + CLEAR_BELOW;
  }
  return out;
}
