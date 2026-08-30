import { rows } from "./reasoning-view.js";

/**
 * How tall the redrawn part of the frame is allowed to get.
 *
 * Ink splits the shell into `<Static>` — settled turns, written once into the
 * terminal's own scrollback — and a dynamic region it repaints every frame.
 * The dynamic region had no height bound at all: `stdout.columns` was read for
 * width and `stdout.rows` was never read anywhere.
 *
 * That is not a cosmetic omission. Ink stops doing incremental repaints once a
 * frame is taller than the viewport and switches to wiping the screen:
 *
 *     const isOverflowing = nextOutputHeight > viewportRows;
 *     return wasOverflowing || (isOverflowing && hadPreviousFrame) || isLeavingFullscreen || …
 *
 * and on that branch it writes `clearTerminal + fullStaticOutput + output` —
 * a full-screen clear plus a re-emit of every settled turn, once per frame at
 * streaming rate. `wasOverflowing` latches, so the frame after you drop back
 * under the viewport clears too. Two symptoms come straight out of this: the
 * screen flashes while a tall block is on screen, and collapsing a tall block
 * (`isLeavingFullscreen`) leaves a band of dead space where it used to be.
 * Windows consoles take the clear branch for *any* fullscreen frame, so the
 * headline install platform sees the worst of it.
 *
 * The fix is to keep the dynamic region under the viewport, which means the two
 * blocks that can grow without limit — expanded reasoning and the live answer —
 * need a budget. Nothing is lost by bounding them: a settled turn is written to
 * `<Static>` in full, so the complete text always reaches scrollback.
 */

/** Rows the rest of the frame needs: composer, status, activity, notices, margins. */
const CHROME_ROWS = 18;

/** Never squeeze a growable block below this, however small the terminal. */
const MIN_BLOCK_ROWS = 4;

/** Used when the terminal cannot say how tall it is. */
const ASSUMED_ROWS = 24;

/**
 * Resolve the viewport height defensively.
 *
 * Mirrors the width rule: a pty with no winsize, a CI capture, or some
 * multiplexers report zero, and a zero budget would collapse every growable
 * block to nothing.
 */
export function resolveViewportRows(reported: number | undefined): number {
  return Math.max(MIN_BLOCK_ROWS + 1, reported || ASSUMED_ROWS);
}

export interface FrameBudget {
  /** Rows allowed to expanded reasoning. */
  reasoning: number;
  /** Rows allowed to the streaming answer. */
  answer: number;
}

/**
 * Split the space left after chrome between the two growable blocks.
 *
 * When the reader has explicitly opened the thinking with Ctrl+R they are
 * reading it, so it takes the larger share; the answer keeps the rest. When
 * reasoning is collapsed it costs a line or six and the answer gets everything.
 */
export function frameBudget(viewportRows: number, reasoningExpanded: boolean): FrameBudget {
  const available = Math.max(MIN_BLOCK_ROWS, viewportRows - CHROME_ROWS);
  if (!reasoningExpanded) return { reasoning: available, answer: available };
  const reasoning = Math.max(MIN_BLOCK_ROWS, Math.ceil(available * 0.6));
  return { reasoning, answer: Math.max(MIN_BLOCK_ROWS, available - reasoning) };
}

export interface ClampedText {
  text: string;
  /** Source lines dropped off the top. */
  hidden: number;
}

/**
 * Keep the newest `maxRows` rows of streaming markdown.
 *
 * Measured in wrapped rows rather than source lines, because a single long
 * paragraph is what actually overflows a narrow terminal. The measurement uses
 * the same word wrapper the reasoning tail uses; it is an estimate, since
 * markdown adds its own blank lines and gutters, so the budget is spent
 * slightly conservatively rather than exactly.
 *
 * A slice can begin inside a fenced code block, which would render the tail as
 * prose and lose the fence's styling. When the kept text holds an odd number of
 * fences, one is put back on the front.
 */
export function clampMarkdownTail(text: string, maxRows: number, width: number): ClampedText {
  if (maxRows <= 0) return { text: "", hidden: text.split("\n").length };
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = Math.max(1, rows(line, Math.max(1, width)).length);
    if (used + cost > maxRows && kept.length > 0) break;
    kept.unshift(line);
    used += cost;
  }
  const hidden = lines.length - kept.length;
  if (hidden === 0) return { text, hidden: 0 };
  // Whether the slice opens inside a code block is decided by what was
  // dropped, not by what was kept: a tail cut deep inside a long fence holds no
  // fence markers at all, and counting only the kept ones would call that
  // prose. Count the fences above the cut instead — an odd number means the
  // block was still open when the slice began.
  const dropped = lines.slice(0, hidden);
  const openFences = dropped.filter((line) => line.trimStart().startsWith("```")).length;
  const body = openFences % 2 === 1 ? ["```", ...kept] : kept;
  return { text: body.join("\n"), hidden };
}
