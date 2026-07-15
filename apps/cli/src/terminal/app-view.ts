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
import { completionCandidates, renderMenu } from "./completion.js";
import { fuzzyPalette, renderPalette, type PaletteItem } from "./palette.js";
import { filterModelItems, renderModelPicker, type ModelPickerItem } from "./model-picker.js";
import { renderReasoningPicker } from "./reasoning.js";
import { completionActive, type InputState } from "./input-state.js";
import type { ReasoningConfiguration, RouteReasoningCapability } from "@morrow/contracts";
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
  wrapText,
} from "./view.js";
import { startupPanelLines, type RecentActivityItem } from "./startup-view.js";

export interface AppFrameOptions {
  columns: number;
  rows: number;
  tick: number;
  elapsedMs?: number;
  jobCount?: number;
  promptLabel: string;
  promptWidth: number;
  /** Absolute clock time, for the startup panel's relative-time labels. */
  nowMs?: number;
}

/**
 * Content for a transient overlay (/status, /output, /diff, /context,
 * Mission Control, a pending approval, …) rendered *inside* the persistent
 * shell instead of replacing it: the identity header and the bordered input
 * box never disappear, so closing the overlay restores the exact prior
 * frame and live activity keeps updating underneath it. This is the single
 * mechanism every overlay goes through — no overlay gets its own bespoke,
 * unclipped full-screen replacement.
 */
export interface OverlayPanel {
  title: string;
  /** Extra pinned lines below the title (e.g. Mission Control's tab bar) —
   *  never clipped, unlike `lines`. */
  subheading?: string[];
  /** Scroll-safe body content, tail-clipped to the available rows exactly
   *  like the normal mission body. */
  lines: string[];
  /** Footer hint shown instead of the normal status hint (e.g. "Esc closes"). */
  footerHint?: string;
  /** Placeholder shown in the input box instead of the default — e.g. during
   *  a pending approval, where ordinary typing is inert. */
  inputPlaceholder?: string;
}

export interface AppFrameContext {
  commands: SlashCommand[];
  paletteItems: PaletteItem[];
  /** Real, project-scoped recent activity shown on the startup panel. */
  recentActivity?: RecentActivityItem[];
  /** The active overlay's content, if one is open. */
  overlayPanel?: OverlayPanel | null;
  /** The /model picker's real item list — see input-state.ts's KeyContext,
   *  which the same array is mutated into (never a second, independently
   *  built list). Empty unless the model overlay is open. */
  modelItems?: ModelPickerItem[];
  /** The currently configured model id ("auto" when unset), so the picker
   *  can mark the current selection without recomputing it. */
  currentModelId?: string | undefined;
  /** The reasoning capability of the route the reasoning overlay is
   *  configuring — set by the controller when that overlay opens. */
  reasoningCap?: RouteReasoningCapability | undefined;
  /** The active reasoning selection, marked in the reasoning selector. */
  currentReasoning?: ReasoningConfiguration | undefined;
  /** Display label for the route the reasoning overlay is configuring. */
  reasoningRouteLabel?: string | undefined;
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
  // The bordered startup panel replaces the header + welcome text for the one
  // moment before any conversation exists — never shown once a task begins.
  const isStartup = isStartupState(term);
  const overlay = ctx.overlayPanel ?? null;

  // ── Fixed top: Morrow chrome ───────────────────────────────────────────────
  const top = isStartup
    ? startupPanelLines(term.meta!, ctx.recentActivity ?? [], out, unicode, opts.columns, opts.nowMs ?? Date.now(), blockedPathGuidanceBlocks(term.meta!, out, unicode))
    : buildTopChrome(term, out, unicode, opts);
  if (overlay) {
    top.push(`  ${out.bold(overlay.title)}`);
    for (const l of overlay.subheading ?? []) top.push(`  ${l}`);
  }

  // ── Fixed bottom: notices + input/overlay + footer ─────────────────────────
  const footer = footerLine(term, input, out, unicode, opts, overlay?.footerHint);
  const noticeLines = [...recentNotices(term, out, unicode), ...queuedRedirectLines(term, out, unicode)];

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
  } else if (input.overlay === "model") {
    const items = filterModelItems(input.modelQuery, ctx.modelItems ?? []);
    const picker = renderModelPicker(items, out, {
      query: input.modelQuery,
      selected: input.modelSelected,
      maxRows: Math.min(8, Math.max(3, Math.floor((opts.rows - top.length - 4) / 2))),
      unicode,
      currentModelId: ctx.currentModelId,
    });
    bottom = [...noticeLines, ...picker];
    cursorWithinBottom = { row: noticeLines.length + 1, col: stripAnsi(picker[1] ?? "").length };
  } else if (input.overlay === "reasoning") {
    const picker = renderReasoningPicker(ctx.reasoningCap ?? { control: "none", efforts: [], budgets: [], source: "unknown" }, out, {
      selected: input.reasoningSelected,
      unicode,
      routeLabel: ctx.reasoningRouteLabel,
      current: ctx.currentReasoning,
    });
    bottom = [...noticeLines, ...picker];
    cursorWithinBottom = { row: noticeLines.length + 1, col: 0 };
  } else {
    const built = buildInputBlock(input, out, unicode, ctx, opts);
    bottom = [...noticeLines, ...built.lines];
    cursorWithinBottom = { row: noticeLines.length + built.cursor.row, col: built.cursor.col };
  }

  // ── Middle: transcript + live region, tail-clipped to remaining rows ────────
  // An open overlay's body replaces the mission body — the header above and
  // the bordered input below never move, so closing the overlay restores
  // exactly the frame that was showing before it opened.
  const middle = overlay ? overlay.lines.map((l) => `  ${l}`) : isStartup ? [] : buildMiddle(term, out, unicode, opts, workspace);
  const reserved = top.length + 1 /*blank*/ + bottom.length + footer.length + 1 /*blank*/;
  const available = Math.max(1, opts.rows - reserved);
  // The live mission body is a recency feed — keep the tail (most recent
  // activity) when it overflows. An overlay (a report/status viewer) is the
  // opposite: its lead lines are the title/summary a user opened it to see,
  // so it keeps the head and marks how much was cut instead of silently
  // dropping the start of the content.
  const clippedMiddle = overlay ? headClip(middle, available, out) : middle.length > available ? middle.slice(middle.length - available) : middle;

  const lines = [...top, "", ...clippedMiddle, "", ...bottom, ...footer];
  const bottomStart = top.length + 1 + clippedMiddle.length + 1;
  const cursor = {
    row: bottomStart + cursorWithinBottom.row,
    col: cursorWithinBottom.col,
  };

  return { lines: lines.map((l) => clipToWidth(l, opts.columns)), cursor };
}

/** Keep the first `available - 1` lines and note how many were cut, rather
 *  than silently dropping the lead lines (title/summary) an overlay's
 *  content usually opens with. */
function headClip(lines: string[], available: number, out: Output): string[] {
  if (lines.length <= available) return lines;
  const kept = Math.max(0, available - 1);
  const cut = lines.length - kept;
  return [...lines.slice(0, kept), out.gray(`  … ${cut} more line${cut === 1 ? "" : "s"} — see /output full`)];
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

  for (const block of blockedPathGuidanceBlocks(meta, out, unicode)) {
    for (const l of block) lines.push("  " + l);
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

/**
 * Adaptive guidance for the common blocked paths (no provider, non-Git dir,
 * resumed session), grouped into logical blocks so a caller can space each
 * one consistently. Shared by `welcomeLines` (kept for direct callers) and
 * the bordered startup panel, so the two never drift on wording.
 */
function blockedPathGuidanceBlocks(meta: SessionMeta, out: Output, unicode: boolean): string[][] {
  const g = glyphs(unicode);
  const blocks: string[][] = [];
  if (meta.providerConfigured === false) {
    blocks.push([
      out.yellow(`${g.warn} No model provider is configured.`),
      out.gray(`   Connect one with `) + out.cyan("morrow auth login") + out.gray(" (or ") + out.cyan("/model") + out.gray(" once connected)."),
    ]);
  }
  if (meta.gitRepo === false) {
    blocks.push([out.gray(`${g.dot} Not a Git repo — change tracking, /diff, and /undo are unavailable. Run `) + out.cyan("git init") + out.gray(" to enable them.")]);
  }
  if (meta.resumed) {
    blocks.push([out.gray(`${g.dot} Resumed your last session. Type to continue, or `) + out.cyan("/new") + out.gray(" for a fresh one.")]);
  }
  return blocks;
}

/** True only before any conversation exists and nothing is running — the one
 *  moment the bordered startup panel replaces the header + welcome text. */
function isStartupState(term: TerminalState): boolean {
  return Boolean(term.meta) && term.conversation.length === 0 && term.plan.length === 0 && term.status === "idle" && term.tools.length === 0;
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

  // The true first-run/empty state is handled by the startup panel in
  // `composeApp` (`isStartupState`), which never calls this function at all.

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

  // "Which mission is running" — the user's own most recent instruction,
  // wrapped rather than clipped, never a fragment reconstructed from
  // provider narration or internal event names.
  if (lastUserIndex >= 0) {
    lines.push(`  ${out.bold("Mission")}`);
    for (const l of wrapText(term.conversation[lastUserIndex]!.text, Math.max(20, opts.columns - 6))) lines.push(`    ${l}`);
    lines.push("");
  }

  // Prior transcript stays chronological. The current answer is deferred until
  // after the activity block below.
  // Intermediate narration is suppressed — the action log below is the
  // truthful record of that work. While a turn streams during tool work,
  // show a single dim tail line so the screen stays calm. The current turn's
  // own instruction is skipped here — the "Mission" heading above already
  // states it once; earlier turns in this session still show normally.
  for (const [index, entry] of term.conversation.entries()) {
    if (index === currentAssistantIndex) continue;
    if (index === lastUserIndex) continue;
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
  const runningTools = term.status === "streaming" ? term.tools.filter((t) => t.status === "running") : [];
  if (items.length > 0 || runningTools.length > 0) lines.push(`  ${out.bold("Activity")}`);
  for (const item of items) for (const l of item.render()) lines.push(l);

  // Live region: running tools with a spinner — only while genuinely
  // streaming. A tool call can be left "running" forever if the stream
  // ends mid-call (pause, cancel, failure/interrupt all just stop sending
  // events); once the task is no longer actively streaming there is
  // nothing truly live, so the spinner must stop rather than animate a
  // paused/finished task forever.
  for (const card of runningTools) lines.push(runningActionLine(card, out, unicode, opts.tick, workspace));

  // A finished task leads with the structured result — the single source of
  // truth for "what happened" — and only then, beneath it, a short prose
  // answer if the model gave one. A long answer is wrapped, never
  // ellipsis-clipped: the structured block already carries the outcome, so
  // the prose underneath is supporting detail, not the thing being judged
  // for truncation risk.
  const isTerminalState =
    term.status === "completed" || term.status === "failed" || term.status === "cancelled" ||
    term.status === "interrupted" || term.status === "stalled" || term.status === "budget-reached";

  if (currentAssistantIndex >= 0 && !isTerminalState) renderConversationEntry(term.conversation[currentAssistantIndex]!);

  // Completion card (compact; the full report stays behind /output).
  if (isTerminalState) {
    lines.push("");
    for (const cl of completionCard(term, out, { unicode, columns: opts.columns, ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}) })) lines.push(cl);

    const finalEntry = currentAssistantIndex >= 0 ? term.conversation[currentAssistantIndex]! : undefined;
    const finalBody = finalEntry?.text.trim();
    if (finalBody) {
      lines.push("");
      const width = Math.max(20, opts.columns - 4);
      for (const raw of finalBody.split("\n")) {
        if (!raw.trim()) { lines.push(""); continue; }
        for (const l of wrapText(raw, width)) lines.push("  " + l);
      }
    }
  }
  return lines;
}

/** Light box-drawing border for the persistent input area (PDF page 1: "the
 *  input must feel like a permanent control surface, not loose text at the
 *  bottom"). Rounded corners distinguish it from the startup panel's square
 *  border while staying in the same restrained, monochrome-safe vocabulary. */
function inputBorder(unicode: boolean) {
  return unicode
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
}

const INPUT_PLACEHOLDER = "Ask, redirect, or type / for commands…";
const INPUT_PLACEHOLDER_ASCII = "Ask, redirect, or type / for commands...";

/** One soft-wrapped visual row of the input buffer: `text` is what's shown,
 *  `startOffset` is that row's first character's absolute offset into
 *  `buffer` (used to place the caret without re-deriving it from scratch). */
interface InputRow {
  text: string;
  startOffset: number;
}

/**
 * Soft-wrap the buffer's logical (newline-separated) lines to `width`,
 * never dropping or clipping a character — a single very long line still
 * fits inside the bordered box instead of overflowing it or getting
 * ellipsis-truncated ("long input wraps safely").
 */
function wrapInputRows(buffer: string, width: number): InputRow[] {
  const avail = Math.max(1, width);
  const rows: InputRow[] = [];
  let offset = 0;
  const segs = buffer.length === 0 ? [""] : buffer.split("\n");
  for (const seg of segs) {
    if (seg.length === 0) {
      rows.push({ text: "", startOffset: offset });
    } else {
      for (let i = 0; i < seg.length; i += avail) rows.push({ text: seg.slice(i, i + avail), startOffset: offset + i });
    }
    offset += seg.length + 1; // +1 for the '\n' joining this segment to the next
  }
  return rows;
}

/** Which row (and column within it) the caret lands on: the last row whose
 *  start is at or before the caret offset — the natural place for a caret
 *  sitting exactly at a soft-wrap boundary. */
function caretRowCol(rows: InputRow[], cursor: number): { rowIndex: number; col: number } {
  let rowIndex = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]!.startOffset <= cursor) rowIndex = i;
    else break;
  }
  return { rowIndex, col: cursor - rows[rowIndex]!.startOffset };
}

function buildInputBlock(
  input: InputState,
  out: Output,
  unicode: boolean,
  ctx: AppFrameContext,
  opts: AppFrameOptions
): { lines: string[]; cursor: { row: number; col: number } } {
  const b = inputBorder(unicode);
  const margin = "  ";
  const outerWidth = Math.max(8, opts.columns - margin.length);
  const contentWidth = Math.max(2, outerWidth - 4); // minus 2 border chars + 1 pad space each side
  const indentWidth = opts.promptWidth; // first row: "› "; continuation rows pad to match
  const wrapWidth = Math.max(1, contentWidth - indentWidth);

  const isEmpty = input.buffer.length === 0;
  const rows = wrapInputRows(input.buffer, wrapWidth);
  const { rowIndex: caretRow, col: caretCol } = caretRowCol(rows, input.cursor);

  const top = out.gray(margin + b.tl + b.h.repeat(outerWidth - 2) + b.tr);
  const bottom = out.gray(margin + b.bl + b.h.repeat(outerWidth - 2) + b.br);
  const v = out.gray(b.v);

  // A narrow box gets the placeholder clipped rather than forcing the row
  // (and therefore the border) wider than the terminal. An open overlay
  // (e.g. a pending approval, where ordinary typing is inert) can supply
  // its own placeholder instead of the default "ask or / for commands" copy.
  const placeholderBudget = Math.max(0, contentWidth - indentWidth);
  const placeholderText = ctx.overlayPanel?.inputPlaceholder ?? (unicode ? INPUT_PLACEHOLDER : INPUT_PLACEHOLDER_ASCII);
  const placeholder = clipToWidth(placeholderText, placeholderBudget);

  const contentRows = rows.map((row, i) => {
    const prefix = i === 0 ? opts.promptLabel : " ".repeat(indentWidth);
    const showPlaceholder = i === 0 && isEmpty;
    const body = showPlaceholder ? out.gray(placeholder) : row.text;
    const visibleLen = showPlaceholder ? placeholder.length : row.text.length;
    const pad = " ".repeat(Math.max(0, contentWidth - indentWidth - visibleLen));
    return `${margin}${v} ${prefix}${body}${pad} ${v}`;
  });

  const lines = [top, ...contentRows, bottom];
  // Row 0 of this block is the top border, so content row N sits at block
  // index N + 1 — matching the pre-border convention where row 1 was always
  // the first content line.
  const cursor = { row: caretRow + 1, col: margin.length + 1 + 1 + indentWidth + caretCol };

  if (!completionActive(input)) return { lines, cursor };

  const matches = completionCandidates(input.buffer, ctx.commands);
  const menu = renderMenu(matches, out, { selected: input.completionSelected, max: 8, unicode });
  // Completion appears directly above the input box, never below it.
  return { lines: [...menu, ...lines], cursor: { row: cursor.row + menu.length, col: cursor.col } };
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
 * Ordinary text typed while a task runs, held for the next message. Rendered
 * with its own glyph (↷) so it can never be mistaken for a tool-activity line
 * (✓/✗/↻/●) or a slash-command notice (info/warn/error) — a third, distinct
 * visual category for "what happens next," never silently discarded.
 */
function queuedRedirectLines(term: TerminalState, out: Output, unicode: boolean): string[] {
  const g = glyphs(unicode);
  return term.queuedMessages.map((text) => `  ${out.cyan(g.queued)} ${out.gray("Queued:")} ${text}`);
}

/**
 * The footer: the compact status line, plus a hint ONLY when context calls
 * for one — an open overlay, a slash command in progress, or the very first
 * session. The permanent shortcut wall is gone; `?` and /help still exist.
 */
function footerLine(term: TerminalState, input: InputState, out: Output, unicode: boolean, opts: AppFrameOptions, overlayHintOverride?: string): string[] {
  const statusOpts = opts.elapsedMs === undefined ? {} : { elapsedMs: opts.elapsedMs };
  const status = statusBar(term, out, unicode, opts.columns, statusOpts);
  if (input.confirmExit) return [status, out.yellow("  Press Ctrl+C again to exit.")];
  if (overlayHintOverride) return [status, out.gray("  " + overlayHintOverride)];
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
