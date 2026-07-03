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
  activityGroupLine,
  clipToWidth,
  completionLines,
  formatElapsed,
  glyphs,
  groupActivities,
  headerLines,
  patchLines,
  relativePath,
  stageBanner,
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
  const workspace = term.meta?.workspacePath;

  // ── Fixed top: Morrow chrome ───────────────────────────────────────────────
  const top = buildTopChrome(term, out, unicode, opts);

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
    cursorWithinBottom = { row: noticeLines.length + 1, col: stripAnsi(palette[1] ?? "").length };
  } else {
    const built = buildInputBlock(input, out, unicode, ctx, opts);
    bottom = [...noticeLines, ...built.lines];
    cursorWithinBottom = { row: noticeLines.length + built.cursor.row, col: built.cursor.col };
  }

  // ── Middle: transcript + live region, tail-clipped to remaining rows ────────
  const middle = buildMiddle(term, out, unicode, opts, workspace);
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

/** Build the chrome at the top: MORROW brand, project, and live status. */
function buildTopChrome(term: TerminalState, out: Output, unicode: boolean, opts: AppFrameOptions): string[] {
  const g = glyphs(unicode);
  const lines: string[] = [];
  const m = term.meta;

  // Line 1: MORROW branding + project
  if (m) {
    const brand = out.bold("MORROW");
    const projectPart = out.cyan(m.projectName);
    const pathPart = out.gray(m.workspacePath);
    lines.push(`  ${brand}  ${projectPart}  ${pathPart}`);
  }

  // Line 2: mode · model · git · memory
  if (m) {
    const bits: string[] = [];
    bits.push(out.gray(modeGlyph(m.mode, m.autoApprove) + " " + m.mode));
    bits.push(out.gray(`${m.provider}/${m.model}`));
    if (term.git) {
      const gitBits = [term.git.branch];
      if (term.git.dirty) gitBits.push(out.yellow("dirty"));
      if (term.git.ahead > 0) gitBits.push(`+${term.git.ahead}`);
      if (term.git.behind > 0) gitBits.push(`-${term.git.behind}`);
      bits.push(out.gray(gitBits.join(" ")));
    }
    if (m.memory) bits.push(out.gray("mem"));
    // Context usage if available.
    if (term.contextUsage) {
      const u = term.contextUsage;
      const pct = u.maxTokens > 0 ? Math.round((u.usedTokens / u.maxTokens) * 100) : 0;
      bits.push(out.gray(`${pct}% ctx`));
    }
    lines.push(`  ${bits.join(out.gray("  " + g.dot + "  "))}`);
  }

  // Line 3: status + elapsed + job count + agents/processes hints
  const statusBits: string[] = [statusWord(term, out, unicode)];
  if (opts.elapsedMs !== undefined && term.status === "streaming") {
    statusBits.push(out.gray(formatElapsed(opts.elapsedMs)));
  }
  if (opts.jobCount) {
    statusBits.push(out.gray(`${opts.jobCount} job${opts.jobCount === 1 ? "" : "s"}`));
  }
  const activeAgents = term.agents.filter((a) => a.status === "running");
  if (activeAgents.length > 0) {
    statusBits.push(out.gray(`${activeAgents.length} agent${activeAgents.length === 1 ? "" : "s"}`));
  }
  const runningProcs = term.processes.filter((p) => p.status === "running");
  if (runningProcs.length > 0) {
    statusBits.push(out.gray(`${runningProcs.length} proc`));
  }
  lines.push(`  ${statusBits.join(out.gray("  " + g.dot + "  "))}`);

  // Divider.
  lines.push(out.gray("  " + "─".repeat(Math.min(opts.columns - 2, 60))));
  return lines;
}

function modeGlyph(mode: string, autoApprove: boolean): string {
  if (autoApprove) return "⚡";
  if (mode.toLowerCase().includes("inspect") || mode.toLowerCase().includes("read-only")) return "🔍";
  if (mode.toLowerCase().includes("plan")) return "📋";
  return "●";
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
    case "stalled":
      return out.yellow("stalled");
    default:
      return out.gray("idle");
  }
}

function buildMiddle(term: TerminalState, out: Output, unicode: boolean, opts: AppFrameOptions, workspace?: string): string[] {
  const lines: string[] = [];

  // Progress stage banner.
  const stage = stageBanner(term.progressStage, term.progressDetail, out, unicode);
  if (stage) {
    lines.push(stage);
    lines.push("");
  }

  // Plan summary.
  if (term.plan.length > 0) {
    lines.push(out.bold("  Plan"));
    for (const step of term.plan) {
      const mark = step.status === "completed" ? out.green("✓") : step.status === "running" ? out.cyan("●") : step.status === "failed" ? out.red("×") : out.gray("○");
      lines.push(`  ${mark} ${step.title}`);
    }
    lines.push("");
  }

  // Conversation.
  for (const entry of term.conversation) {
    const label = entry.role === "user" ? out.green("you › ") : out.magenta("morrow › ");
    const body = entry.text.length ? entry.text : entry.streaming ? out.gray("…") : "";
    const segs = body.split("\n");
    for (const [i, seg] of segs.entries()) lines.push((i === 0 ? label : "        ") + seg);
  }

  // Completed/failed tool cards and patches.
  for (const card of term.tools) {
    if (card.status !== "running") for (const cl of toolCardLines(card, out, unicode, 0, workspace)) lines.push(cl);
  }
  for (const patch of term.patches) for (const pl of patchLines(patch, out, unicode, workspace)) lines.push(pl);

  // Live region: grouped activity + running tool cards.
  const groups = groupActivities(term.activity);
  for (const g of groups.slice(-3)) lines.push(activityGroupLine(g, out, unicode));
  for (const card of term.tools) {
    if (card.status === "running") for (const cl of toolCardLines(card, out, unicode, opts.tick, workspace)) lines.push(cl);
  }

  // Completion summary.
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
  const g = glyphs(unicode);
  const segs = input.buffer.split("\n");
  const inputLines: string[] = [];

  // Visual separator bar above the input.
  inputLines.push(out.gray("  " + "─".repeat(Math.min(opts.columns - 2, 40))));

  // The input line(s).
  for (const [i, seg] of segs.entries()) {
    inputLines.push((i === 0 ? opts.promptLabel + seg : "  " + seg));
  }

  // Cursor row/col within this block (offset by 1 for the separator).
  const before = input.buffer.slice(0, input.cursor).split("\n");
  const cursorRow = before.length;
  const lastSeg = before[before.length - 1] ?? "";
  const cursorCol = (cursorRow === 1 ? opts.promptWidth : 2) + lastSeg.length;

  const lines = [...inputLines];
  if (completionActive(input)) {
    const matches = filterCommands(input.buffer, ctx.commands);
    for (const ml of renderMenu(matches, out, { selected: input.completionSelected, max: 8, unicode })) lines.push(ml);
  }
  return { lines, cursor: { row: cursorRow - 1, col: cursorCol } };
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
      : input.overlay === "output"
        ? "Esc closes · output retained in task record"
        : input.overlay === "tasktree"
          ? "Esc closes · task tree from last mission"
          : input.overlay === "history"
            ? "type to search · Enter recall · Esc close"
            : "/ commands · Ctrl+K palette · Ctrl+T tree · Ctrl+R history · Ctrl+O output · ? help · Ctrl+C exit";
  return [out.gray("  " + hint)];
}
