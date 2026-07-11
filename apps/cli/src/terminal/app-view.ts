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
  actionLine,
  clipToWidth,
  completionCard,
  glyphs,
  headerLines,
  recoveryEntryLines,
  runningActionLine,
  statusBar,
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
/**
 * First-run guidance only. The header directly above already states the
 * project, branch, model, and mode — repeating them here was one of the
 * duplicate walls this redesign removes. This panel now owns exactly the
 * facts the header cannot show: blocked paths and what to type next.
 */
export function welcomeLines(meta: SessionMeta, out: Output, unicode: boolean): string[] {
  const g = glyphs(unicode);
  const lines: string[] = [];
  const dot = out.gray(g.dot);

  lines.push("  " + out.bold("Welcome to Morrow") + out.gray(" — private intelligence, built around you."));
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

/** True for assistant entries the default view renders in full. */
function showsAssistantEntry(term: TerminalState, entry: TerminalState["conversation"][number]): boolean {
  if (entry.aborted) return false;
  if (entry.final) return true;
  if (entry.streaming) return true;
  // A completed, non-final turn is intermediate narration — the structured
  // action log represents that work; the text stays in /output full.
  return false;
}

function buildMiddle(term: TerminalState, out: Output, unicode: boolean, opts: AppFrameOptions, workspace?: string): string[] {
  const lines: string[] = [];

  // First-run/empty state: no conversation yet and nothing streaming → welcome.
  if (term.meta && term.conversation.length === 0 && term.plan.length === 0 && term.status === "idle" && term.tools.length === 0) {
    return welcomeLines(term.meta, out, unicode);
  }

  const hasToolWork = term.tools.length > 0;

  const renderConversationEntry = (entry: TerminalState["conversation"][number]): void => {
    if (entry.role === "assistant" && entry.streaming && hasToolWork) {
      const tail = entry.text.split("\n").filter((line) => line.trim()).pop();
      if (tail) lines.push(out.gray("  " + clipToWidth(tail.trim(), Math.max(20, opts.columns - 4))));
      return;
    }
    const label = entry.role === "user" ? out.green("you › ") : out.magenta("morrow › ");
    const body = entry.text.length ? entry.text : entry.streaming ? out.gray("…") : "";
    if (!body) return;
    const segments = body.split("\n");
    for (const [index, segment] of segments.entries()) lines.push((index === 0 ? label : "        ") + segment);
  };

  // The current turn's answer is rendered after its structured activity and
  // immediately before completion. This keeps the answer in the high-priority
  // tail of a narrow frame instead of allowing action history to push it out.
  let lastUserIndex = -1;
  for (let index = term.conversation.length - 1; index >= 0; index -= 1) {
    if (term.conversation[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  let currentAssistantIndex = -1;
  for (let index = lastUserIndex + 1; index < term.conversation.length; index += 1) {
    const entry = term.conversation[index]!;
    if (entry.role === "assistant" && showsAssistantEntry(term, entry)) currentAssistantIndex = index;
  }

  // Prior transcript stays chronological. The current answer is deferred until
  // after the activity block below.
  // Intermediate narration is suppressed — the action log below is the
  // truthful record of that work. While a turn streams during tool work,
  // show a single dim tail line so the screen stays calm.
  for (const [index, entry] of term.conversation.entries()) {
    if (index === currentAssistantIndex) continue;
    if (entry.role === "assistant" && !showsAssistantEntry(term, entry)) continue;
    renderConversationEntry(entry);
  }

  // Structured action log: one line per meaningful completed action, with
  // recovery stories interleaved chronologically.
  type Item = { at: number; render: () => string[] };
  const items: Item[] = [];
  const taskFailed = term.status === "failed" || term.status === "stalled" || term.status === "budget-reached";
  for (const card of term.tools) {
    if (card.status === "running") continue;
    items.push({ at: card.startedAt, render: () => { const l = actionLine(card, out, unicode, workspace); return l ? [l] : []; } });
  }
  for (const entry of term.recoveries) {
    items.push({ at: entry.at, render: () => recoveryEntryLines(entry, out, unicode, taskFailed) });
  }
  items.sort((a, b) => a.at - b.at);
  for (const item of items) for (const l of item.render()) lines.push(l);

  // Live region: running tools with a spinner — only while genuinely
  // streaming. A tool call can be left "running" forever if the stream
  // ends mid-call (pause, cancel, failure/interrupt all just stop sending
  // events); once the task is no longer actively streaming there is
  // nothing truly live, so the spinner must stop rather than animate a
  // paused/finished task forever.
  if (term.status === "streaming") {
    for (const card of term.tools) {
      if (card.status === "running") lines.push(runningActionLine(card, out, unicode, opts.tick, workspace));
    }
  }

  if (currentAssistantIndex >= 0) renderConversationEntry(term.conversation[currentAssistantIndex]!);

  // Completion card (compact; the full report stays behind /output).
  if (term.status === "completed" || term.status === "failed" || term.status === "cancelled" || term.status === "interrupted" || term.status === "stalled" || term.status === "budget-reached") {
    lines.push("");
    for (const cl of completionCard(term, out, { unicode, ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}) })) lines.push(cl);
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

/**
 * The footer: the compact status line, plus a hint ONLY when context calls
 * for one — an open overlay, a slash command in progress, or the very first
 * session. The permanent shortcut wall is gone; `?` and /help still exist.
 */
function footerLine(term: TerminalState, input: InputState, out: Output, unicode: boolean, opts: AppFrameOptions): string[] {
  const statusOpts = opts.elapsedMs === undefined ? {} : { elapsedMs: opts.elapsedMs };
  const status = statusBar(term, out, unicode, opts.columns, statusOpts);
  if (input.confirmExit) return [status, out.yellow("  Press Ctrl+C again to exit.")];
  const overlayHint =
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
              : null;
  if (overlayHint) return [status, out.gray("  " + overlayHint)];
  // Typing a slash command → point at completion; Tab is not obvious.
  if (input.buffer.startsWith("/")) return [status, out.gray("  Tab completes · Enter runs · ? help")];
  // First session (nothing has happened yet) → one short orientation line.
  const firstSession = term.conversation.length === 0 && term.tools.length === 0 && term.status === "idle" && !term.meta?.resumed;
  if (firstSession) return [status, out.gray("  / commands · Ctrl+K palette · ? help")];
  return [status];
}
