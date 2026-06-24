/**
 * Pure views: `TerminalState` (or a slice of it) → `string[]` lines.
 *
 * No I/O. Colour and glyphs come from the injected `Output` (so `--no-color`
 * and ASCII modes are honoured) plus the `unicode` flag. Because these are pure,
 * the whole screen is snapshot-testable with a no-color `Output` and no TTY.
 */
import type { Output } from "../cli/output.js";
import { stripAnsi } from "../cli/output.js";
import type { ActivityKind } from "./events.js";
import type { ActivityEntry, PatchEntry, TerminalState, ToolCard } from "./state.js";

export interface Glyphs {
  ok: string;
  fail: string;
  run: string;
  arrow: string;
  bullet: string;
  dot: string;
  warn: string;
  spinner: string[];
}

export function glyphs(unicode: boolean): Glyphs {
  return unicode
    ? { ok: "✓", fail: "✖", run: "•", arrow: "↳", bullet: "◦", dot: "·", warn: "⚠", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] }
    : { ok: "+", fail: "x", run: "*", arrow: ">", bullet: "-", dot: "-", warn: "!", spinner: ["-", "\\", "|", "/"] };
}

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  inspecting: "inspecting",
  reading: "reading",
  searching: "searching",
  planning: "planning",
  running: "running",
  applying_patch: "applying patch",
  verifying: "verifying",
  waiting: "waiting",
  retrying: "retrying",
  delegating: "delegating",
  completing: "completing",
};

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function approvalLabel(approval: ToolCard["approval"] | PatchEntry["approval"]): string | null {
  switch (approval) {
    case "human":
      return "approved";
    case "auto":
      return "auto-approved";
    case "trusted":
      return "trusted";
    default:
      return null;
  }
}

/** The session header: identity + the live facts a user steers by. */
export function headerLines(state: TerminalState, out: Output): string[] {
  const m = state.meta;
  if (!m) return [];
  const rows: Array<[string, string]> = [
    ["Project", `${m.projectName}  ${out.gray(m.workspacePath)}`],
    ["Branch", m.branch],
    ["Model", `${m.provider} · ${m.model}  ${out.gray(m.privacy)}`],
    ["Mode", m.mode],
    ["Memory", m.memory ? "project context on" : "off"],
  ];
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return rows.map(([k, v]) => `  ${out.gray((k + ":").padEnd(width + 1))} ${v}`);
}

/** A compact tool card: name, purpose, status, elapsed, provenance, result. */
export function toolCardLines(card: ToolCard, out: Output, unicode: boolean, tick = 0): string[] {
  const g = glyphs(unicode);
  const statusGlyph =
    card.status === "completed" ? out.green(g.ok) : card.status === "failed" ? out.red(g.fail) : out.gray(g.spinner[tick % g.spinner.length]!);
  const head = [`  ${statusGlyph} ${out.bold(card.name)}`];
  if (card.purpose) head.push(out.gray(`${g.dot} ${card.purpose}`));
  if (card.scope) head.push(out.gray(`${g.dot} ${card.scope}`));
  if (card.elapsedMs !== undefined) head.push(out.gray(`${g.dot} ${formatElapsed(card.elapsedMs)}`));
  const lines = [head.join(" ")];

  const tail: string[] = [];
  const appr = approvalLabel(card.approval);
  if (appr) tail.push(out.gray(appr));
  if (card.status === "failed" && card.error) {
    tail.push(out.red(truncate(card.error, 100)));
  } else if (card.summary) {
    tail.push(out.gray(truncate(card.summary, 100)));
  }
  if (card.outputRef) tail.push(out.gray(`[${card.outputRef}]`));
  if (tail.length) lines.push(`    ${g.arrow} ${tail.join("  ")}`);
  return lines;
}

/** A single observable-activity line (never chain-of-thought). */
export function activityLine(entry: ActivityEntry, out: Output, unicode: boolean): string {
  const g = glyphs(unicode);
  const label = ACTIVITY_LABEL[entry.kind];
  const parts = [out.gray(`  ${g.bullet} ${label}`)];
  if (entry.detail) parts.push(out.gray(entry.detail));
  if (entry.count !== undefined) parts.push(out.gray(`${g.dot} ${entry.count} result${entry.count === 1 ? "" : "s"}`));
  return parts.join(" ");
}

/** Patch summary: files, churn, provenance, applied/verification state. */
export function patchLines(patch: PatchEntry, out: Output, unicode: boolean): string[] {
  const g = glyphs(unicode);
  const stateLabel = patch.applied ? out.green("applied") : out.yellow("proposed");
  const churn: string[] = [];
  if (patch.additions !== undefined) churn.push(out.green(`+${patch.additions}`));
  if (patch.deletions !== undefined) churn.push(out.red(`-${patch.deletions}`));
  const head = `  ${g.bullet} patch ${stateLabel}  ${out.gray(patch.files.join(", "))}${churn.length ? "  " + churn.join(" ") : ""}`;
  const lines = [head];
  const tail: string[] = [];
  if (patch.explanation) tail.push(out.gray(truncate(patch.explanation, 100)));
  const appr = approvalLabel(patch.approval);
  if (appr) tail.push(out.gray(appr));
  if (tail.length) lines.push(`    ${g.arrow} ${tail.join("  ")}`);
  return lines;
}

/** End-of-task summary built only from observed, structured facts. */
export function completionLines(state: TerminalState, out: Output, unicode: boolean): string[] {
  const g = glyphs(unicode);
  const commandsRun = state.tools.filter((t) => t.name === "run_command").length;
  const filesChanged = new Set(state.patches.flatMap((p) => p.files)).size;
  const failures = state.tools.filter((t) => t.status === "failed").length;

  const statusText =
    state.status === "completed"
      ? out.green(`${g.ok} completed`)
      : state.status === "failed"
        ? out.red(`${g.fail} failed`)
        : state.status === "cancelled"
          ? out.yellow("cancelled")
          : state.status === "interrupted"
            ? out.yellow("interrupted")
            : String(state.status);

  const rows: Array<[string, string]> = [["Result", statusText]];
  if (filesChanged > 0) rows.push(["Files changed", String(filesChanged)]);
  if (commandsRun > 0) rows.push(["Commands run", String(commandsRun)]);
  if (state.tools.length > 0) rows.push(["Tool calls", String(state.tools.length)]);
  if (failures > 0) rows.push(["Tool failures", out.red(String(failures))]);
  if (state.lastError) rows.push(["Error", out.red(truncate(state.lastError, 120))]);

  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return rows.map(([k, v]) => `  ${out.gray((k + ":").padEnd(width + 1))} ${v}`);
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/**
 * Clip a (possibly colored) line to a visible column budget without splitting
 * ANSI codes. Conservative: if the visible text exceeds `columns`, we strip
 * color and hard-truncate, which keeps region math exact for the frame renderer.
 */
export function clipToWidth(line: string, columns: number): string {
  if (columns <= 0) return line;
  const visible = stripAnsi(line);
  if (visible.length <= columns) return line;
  return visible.slice(0, Math.max(0, columns - 1)) + "…";
}

export interface FrameOptions {
  columns: number;
  rows: number;
  /** Animation tick for spinners. */
  tick: number;
  /** Footer hint, e.g. key bindings. */
  hint?: string;
}

/**
 * Compose the full interactive frame: header, a bounded conversation tail,
 * recent activity, running tool cards, and a status footer — clipped to the
 * terminal size so the region math stays exact. Pure and snapshot-testable.
 */
export function composeFrame(state: TerminalState, out: Output, unicode: boolean, opts: FrameOptions): string[] {
  const lines: string[] = [];

  for (const l of headerLines(state, out)) lines.push(l);
  lines.push("");

  // Conversation tail (labelled, one logical block per message).
  const convo: string[] = [];
  for (const entry of state.conversation) {
    const label = entry.role === "user" ? out.green("you › ") : out.magenta("morrow › ");
    const body = entry.text.length ? entry.text : entry.streaming ? out.gray("…") : "";
    for (const [i, raw] of body.split("\n").entries()) {
      convo.push((i === 0 ? label : "      ") + raw);
    }
  }

  // Recent activity + running tool cards form the live region.
  const live: string[] = [];
  for (const a of state.activity.slice(-4)) live.push(activityLine(a, out, unicode));
  for (const card of state.tools.filter((t) => t.status === "running")) {
    for (const cl of toolCardLines(card, out, unicode, opts.tick)) live.push(cl);
  }

  const footer = statusFooter(state, out, unicode, opts.hint);

  // Budget rows: header is fixed at top; conversation + live share the middle;
  // footer is fixed at the bottom. Keep the most recent content when clipped.
  const reserved = lines.length + footer.length + 1;
  const available = Math.max(3, opts.rows - reserved);
  const middle = [...convo, "", ...live];
  const clippedMiddle = middle.length > available ? middle.slice(middle.length - available) : middle;
  for (const l of clippedMiddle) lines.push(l);

  lines.push("");
  for (const l of footer) lines.push(l);

  return lines.map((l) => clipToWidth(l, opts.columns));
}

function statusFooter(state: TerminalState, out: Output, unicode: boolean, hint?: string): string[] {
  const g = glyphs(unicode);
  const status =
    state.status === "streaming"
      ? out.cyan(`${g.run} working`)
      : state.status === "completed"
        ? out.green(`${g.ok} ready`)
        : state.status === "failed"
          ? out.red(`${g.fail} failed`)
          : state.status === "cancelled" || state.status === "interrupted"
            ? out.yellow(state.status)
            : out.gray("idle");
  return [`  ${status}`, hint ? out.gray(`  ${hint}`) : out.gray("  Ctrl+C cancel · Ctrl+L repaint · /help")];
}

