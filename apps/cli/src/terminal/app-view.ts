/**
 * The integrated session frame.
 *
 * `composeApp` folds the conversation/activity/tool state AND the input-editor
 * state into one frame: a pinned header, a bounded transcript + live region, the
 * input area, and an overlay (slash-completion menu or the Ctrl+K palette) — plus
 * the exact cursor position so the controller can place a real, visible caret.
 * Pure and snapshot-testable.
 */
import type { Output } from "../cli/output.js";
import { stripAnsi } from "../cli/output.js";
import type { SlashCommand } from "./commands.js";
import { filterCommands, renderMenu } from "./completion.js";
import { fuzzyPalette, renderPalette, type PaletteItem } from "./palette.js";
import { completionActive, type InputState } from "./input-state.js";
import type { TerminalState } from "./state.js";
import {
  activityLine,
  clipToWidth,
  completionLines,
  formatElapsed,
  glyphs,
  headerLines,
  patchLines,
  toolCardLines,
} from "./view.js";

export interface AppFrameOptions {
  columns: number;
  rows: number;
  tick: number;
  elapsedMs?: number;
  jobCount?: number;
  promptLabel: string;
  promptWidth: number;
}

export interface AppFrameContext {
  commands: SlashCommand[];
  paletteItems: PaletteItem[];
}

export interface AppFrame {
  lines: string[];
  cursor: { row: number; col: number };
}

export function composeApp(
  term: TerminalState,
  input: InputState,
  out: Output,
  unicode: boolean,
  ctx: AppFrameContext,
  opts: AppFrameOptions
): AppFrame {
  // ── Fixed top: header ──────────────────────────────────────────────────────
  const top: string[] = [];
  for (const l of headerLines(term, out)) top.push(l);
  const statusBits: string[] = [statusWord(term, out, unicode)];
  if (opts.elapsedMs !== undefined && term.status === "streaming") statusBits.push(out.gray(formatElapsed(opts.elapsedMs)));
  if (opts.jobCount) statusBits.push(out.gray(`${opts.jobCount} job${opts.jobCount === 1 ? "" : "s"}`));
  top.push(`  ${statusBits.join(out.gray("  ·  "))}`);
  top.push(out.gray("  " + "─".repeat(Math.min(opts.columns - 2, 60))));

  // ── Fixed bottom: notices + input/overlay + footer ─────────────────────────
  const footer = footerLine(input, out, unicode);
  const noticeLines = recentNotices(term, out, unicode);

  let bottom: string[];
  let cursorWithinBottom: { row: number; col: number };
  if (input.overlay === "palette") {
    const items = fuzzyPalette(input.paletteQuery, ctx.paletteItems);
    const palette = renderPalette(items, out, {
      query: input.paletteQuery,
      selected: input.paletteSelected,
      max: Math.min(8, Math.max(3, opts.rows - top.length - 4)),
      unicode,
      columns: opts.columns,
    });
    bottom = [...noticeLines, ...palette];
    // Cursor sits at the end of the palette query line (second palette line).
    cursorWithinBottom = { row: noticeLines.length + 1, col: stripAnsi(palette[1] ?? "").length };
  } else {
    const built = buildInputBlock(input, out, unicode, ctx, opts);
    bottom = [...noticeLines, ...built.lines];
    cursorWithinBottom = { row: noticeLines.length + built.cursor.row, col: built.cursor.col };
  }

  // ── Middle: transcript + live region, tail-clipped to remaining rows ────────
  const middle = buildMiddle(term, out, unicode, opts);
  const reserved = top.length + 1 /*blank*/ + bottom.length + footer.length + 1 /*blank*/;
  const available = Math.max(1, opts.rows - reserved);
  const clippedMiddle = middle.length > available ? middle.slice(middle.length - available) : middle;

  const lines = [...top, "", ...clippedMiddle, "", ...bottom, ...footer];
  const bottomStart = top.length + 1 + clippedMiddle.length + 1;
  const cursor = {
    row: bottomStart + cursorWithinBottom.row,
    col: cursorWithinBottom.col,
  };

  return { lines: lines.map((l) => clipToWidth(l, opts.columns)), cursor };
}

function statusWord(term: TerminalState, out: Output, unicode: boolean): string {
  const g = glyphs(unicode);
  switch (term.status) {
    case "streaming":
      return out.cyan(`${g.run} working`);
    case "completed":
      return out.green(`${g.ok} ready`);
    case "failed":
      return out.red(`${g.fail} failed`);
    case "cancelled":
    case "interrupted":
      return out.yellow(term.status);
    case "budget-reached":
      return out.yellow("budget reached");
    default:
      return out.gray("idle");
  }
}

function buildMiddle(term: TerminalState, out: Output, unicode: boolean, opts: AppFrameOptions): string[] {
  const lines: string[] = [];
  if (term.plan.length > 0) {
    lines.push(out.bold("  Plan"));
    for (const step of term.plan) {
      const mark = step.status === "completed" ? out.green("✓") : step.status === "running" ? out.cyan("●") : step.status === "failed" ? out.red("×") : out.gray("○");
      lines.push(`  ${mark} ${step.title}`);
    }
    lines.push("");
  }
  for (const entry of term.conversation) {
    const label = entry.role === "user" ? out.green("you › ") : out.magenta("morrow › ");
    const body = entry.text.length ? entry.text : entry.streaming ? out.gray("…") : "";
    const segs = body.split("\n");
    for (const [i, seg] of segs.entries()) lines.push((i === 0 ? label : "        ") + seg);
  }
  // Completed/failed tool cards and patches form the recent transcript tail.
  for (const card of term.tools) {
    if (card.status !== "running") for (const cl of toolCardLines(card, out, unicode)) lines.push(cl);
  }
  for (const patch of term.patches) for (const pl of patchLines(patch, out, unicode)) lines.push(pl);
  // Live region: recent activity + running tool cards (animated).
  for (const a of term.activity.slice(-3)) lines.push(activityLine(a, out, unicode));
  for (const card of term.tools) {
    if (card.status === "running") for (const cl of toolCardLines(card, out, unicode, opts.tick)) lines.push(cl);
  }
  if (term.status === "completed" || term.status === "failed") {
    lines.push("");
    for (const cl of completionLines(term, out, unicode)) lines.push(cl);
  }
  return lines;
}

function buildInputBlock(
  input: InputState,
  out: Output,
  unicode: boolean,
  ctx: AppFrameContext,
  opts: AppFrameOptions
): { lines: string[]; cursor: { row: number; col: number } } {
  const segs = input.buffer.split("\n");
  const inputLines = segs.map((seg, i) => (i === 0 ? opts.promptLabel + seg : "  " + seg));

  // Cursor row/col within this block.
  const before = input.buffer.slice(0, input.cursor).split("\n");
  const cursorRow = before.length - 1;
  const lastSeg = before[before.length - 1] ?? "";
  const cursorCol = (cursorRow === 0 ? opts.promptWidth : 2) + lastSeg.length;

  const lines = [...inputLines];
  if (completionActive(input)) {
    const matches = filterCommands(input.buffer, ctx.commands);
    for (const ml of renderMenu(matches, out, { selected: input.completionSelected, max: 8, unicode })) lines.push(ml);
  }
  return { lines, cursor: { row: cursorRow, col: cursorCol } };
}

function recentNotices(term: TerminalState, out: Output, unicode: boolean): string[] {
  const g = glyphs(unicode);
  return term.notices.slice(-3).map((n) => {
    const mark = n.level === "error" ? out.red(g.fail) : n.level === "warn" ? out.yellow(g.warn) : out.cyan(g.dot);
    const body = n.level === "error" ? out.red(n.text) : n.level === "warn" ? out.yellow(n.text) : out.gray(n.text);
    return `  ${mark} ${body}`;
  });
}

function footerLine(input: InputState, out: Output, unicode: boolean): string[] {
  if (input.confirmExit) return [out.yellow("  Press Ctrl+C again to exit.")];
  const hint =
    input.overlay === "palette"
      ? "↑/↓ select · Enter run · Esc close"
      : "/ commands · Ctrl+K palette · Ctrl+C cancel/exit · Ctrl+L repaint";
  return [out.gray("  " + hint)];
}
