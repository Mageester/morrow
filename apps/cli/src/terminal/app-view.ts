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
import type { SessionMeta } from "./events.js";
import type { TerminalState } from "./state.js";
import {
  activityGroupLine,
  clipToWidth,
  completionLines,
  glyphs,
  groupActivities,
  headerLines,
  patchLines,
  relativePath,
  stageBanner,
  statusBar,
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
  const footer = footerLine(term, input, out, unicode, opts);
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
  const beta28 = headerLines(term, out, { unicode, columns: opts.columns, ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}) });
  beta28.push(out.gray("  " + "-".repeat(Math.min(opts.columns - 2, 60))));
  return beta28;
}

/**
 * The first-run/empty-state welcome panel. Shown only before any conversation
 * exists, while the session is idle. Surfaces the six things a new user must
 * understand — what Morrow is, whether a project is selected, whether a provider
 * is configured, which model and mode are active, and what to type next — plus
 * adaptive guidance for the common blocked paths (no provider, non-Git dir).
 *
 * Pure: derives entirely from `SessionMeta` so it is deterministic at startup
 * before any git.state/routing event has folded in.
 */
export function welcomeLines(meta: SessionMeta, out: Output, unicode: boolean): string[] {
  const g = glyphs(unicode);
  const lines: string[] = [];
  const dot = out.gray(g.dot);

  lines.push("  " + out.bold("Welcome to Morrow") + out.gray(" — private intelligence, built around you."));
  lines.push("");

  // Project + git posture.
  const projectVal =
    meta.gitRepo === false
      ? `${out.cyan(meta.projectName)}  ${out.gray("· not a Git repository")}`
      : `${out.cyan(meta.projectName)}  ${out.gray("· " + meta.branch)}`;
  lines.push(`  ${out.gray("Project ")}  ${projectVal}`);

  // Provider posture.
  const providerVal =
    meta.providerConfigured === false
      ? out.yellow("not configured")
      : `${out.cyan(meta.provider)}  ${out.gray("· " + meta.privacy)}`;
  lines.push(`  ${out.gray("Provider")}  ${providerVal}`);
  lines.push(`  ${out.gray("Model   ")}  ${meta.providerConfigured === false ? out.gray("—") : out.cyan(meta.model)}`);
  lines.push(`  ${out.gray("Mode    ")}  ${meta.mode}`);
  lines.push("");

  // Adaptive guidance for blocked paths, most important first.
  if (meta.providerConfigured === false) {
    lines.push("  " + out.yellow(`${g.warn} No model provider is configured.`));
    lines.push("  " + out.gray(`   Connect one with `) + out.cyan("morrow auth login") + out.gray(" (or ") + out.cyan("/model") + out.gray(" once connected)."));
    lines.push("");
  }
  if (meta.gitRepo === false) {
    lines.push("  " + out.gray(`${g.dot} Not a Git repo — change tracking, /diff, and /undo are unavailable. Run `) + out.cyan("git init") + out.gray(" to enable them."));
    lines.push("");
  }
  if (meta.resumed) {
    lines.push("  " + out.gray(`${g.dot} Resumed your last session. Type to continue, or `) + out.cyan("/new") + out.gray(" for a fresh one."));
    lines.push("");
  }

  // What to type next.
  const suggestions =
    meta.providerConfigured === false
      ? [out.cyan("morrow auth login"), out.cyan("? help")]
      : [out.gray("ask a question"), out.cyan("/model"), out.cyan("/mode"), out.cyan("? help")];
  lines.push("  " + out.gray("Try:  ") + suggestions.join(`  ${dot}  `));
  lines.push("  " + out.gray("Type your first message below to begin."));
  return lines;
}

function buildMiddle(term: TerminalState, out: Output, unicode: boolean, opts: AppFrameOptions, workspace?: string): string[] {
  const lines: string[] = [];

  // First-run/empty state: no conversation yet and nothing streaming → welcome.
  if (term.meta && term.conversation.length === 0 && term.plan.length === 0 && term.status === "idle" && term.tools.length === 0) {
    return welcomeLines(term.meta, out, unicode);
  }

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

  // Recovery hints for non-successful task states.
  if (term.status === "failed" || term.status === "interrupted" || term.status === "cancelled" || term.status === "stalled" || term.status === "budget-reached") {
    lines.push("");
    lines.push(out.yellow("  Recovery"));
    const hints: string[] = [];
    hints.push("/continue to resume");
    hints.push("/diff to inspect changes");
    hints.push("/undo to rollback");
    hints.push("/result for details");
    hints.push("/output to see outputs");
    lines.push(`  ${out.gray(hints.join(" · "))}`);
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

  // Cursor row/col within this block. `cursorRow` is the 1-based line the caret
  // sits on; because the separator occupies block index 0, segment N lands at
  // block index N, so the block-relative caret row equals `cursorRow`.
  const before = input.buffer.slice(0, input.cursor).split("\n");
  const cursorRow = before.length;
  const lastSeg = before[before.length - 1] ?? "";
  const cursorCol = (cursorRow === 1 ? opts.promptWidth : 2) + lastSeg.length;

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

function footerLine(term: TerminalState, input: InputState, out: Output, unicode: boolean, opts: AppFrameOptions): string[] {
  const statusOpts = opts.elapsedMs === undefined ? {} : { elapsedMs: opts.elapsedMs };
  const beta28Status = statusBar(term, out, unicode, opts.columns, statusOpts);
  if (input.confirmExit) return [beta28Status, out.yellow("  Press Ctrl+C again to exit.")];
  const hint =
    input.overlay === "palette"
      ? "↑/↓ select · Enter run · Esc close"
      : input.overlay === "output"
        ? "Esc closes · output retained in task record"
        : input.overlay === "tasktree"
          ? "Esc closes · task tree from last mission"
          : input.overlay === "mission"
            ? "← → or 1/2/3 tabs · Esc close"
            : input.overlay === "history"
            ? "type to search · Enter recall · Esc close"
            : "/ commands · Ctrl+K palette · Ctrl+T mission · Ctrl+R history · Ctrl+O output · ? help · Ctrl+C exit";
  return [beta28Status, out.gray("  " + hint)];
}
