/**
 * Pure views: `TerminalState` (or a slice of it) → `string[]` lines.
 *
 * No I/O. Colour and glyphs come from the injected `Output` (so `--no-color`
 * and ASCII modes are honoured) plus the `unicode` flag. Because these are pure,
 * the whole screen is snapshot-testable with a no-color `Output` and no TTY.
 */
import type { Output } from "../cli/output.js";
import { stripAnsi } from "../cli/output.js";
import type { ActivityKind, ProgressStage } from "./events.js";
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

/** Map activity kind → progress stage. */
const STAGE_FOR_KIND: Record<ActivityKind, ProgressStage> = {
  inspecting: "understanding",
  reading: "understanding",
  searching: "understanding",
  planning: "planning",
  running: "running_checks",
  applying_patch: "editing",
  verifying: "verifying",
  waiting: "waiting_for_approval",
  retrying: "running_checks",
  delegating: "understanding",
  completing: "completed",
};

const STAGE_LABEL: Record<ProgressStage, string> = {
  understanding: "Understanding project",
  inspecting: "Inspecting",
  planning: "Planning changes",
  editing: "Editing",
  running_checks: "Running checks",
  waiting_for_approval: "Waiting for approval",
  verifying: "Verifying",
  completed: "Completed",
  failed: "Failed",
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

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Shorten an absolute path to a relative one when it's under the workspace.
 * Falls back to the basename if the path is external but long.
 */
export function relativePath(abs: string, workspace?: string): string {
  if (!abs) return abs;
  // Already looks relative.
  if (!abs.startsWith("/") && !/^[A-Z]:[\\/]/i.test(abs)) return abs;
  if (workspace) {
    const ws = workspace.replace(/[\\/]$/, "");
    const norm = abs.replace(/\\/g, "/");
    const wsNorm = ws.replace(/\\/g, "/");
    if (norm.startsWith(wsNorm + "/")) return norm.slice(wsNorm.length + 1);
  }
  // Fallback: just the basename if it's long.
  const parts = abs.replace(/\\/g, "/").split("/");
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : abs;
}

// ── Stage banner ──────────────────────────────────────────────────────────────

/**
 * Renders a compact progress-stage banner line (e.g. "Understanding project...").
 * Returns empty string if no stage is set.
 */
export function stageBanner(stage: ProgressStage | undefined, detail: string | undefined, out: Output, unicode: boolean): string | null {
  if (!stage) return null;
  const g = glyphs(unicode);
  const label = STAGE_LABEL[stage] ?? stage;
  // Only show ellipsis when work is in flight.
  const inFlight = !["completed", "failed"].includes(stage);
  let line = `  ${out.bold(label)}`;
  if (detail) line += out.gray(` ${g.dot} ${detail}`);
  if (inFlight) line += out.gray("…");
  return line;
}

// ── Activity grouping ─────────────────────────────────────────────────────────

export interface ActivityGroup {
  kind: ActivityKind;
  stage: ProgressStage;
  targets: string[];
  counts: number[];
  at: number;
}

/**
 * Collapse a flat activity list into consecutive-kind groups.
 * "reading" + "searching" + "inspecting" all merge into the "understanding"
 * stage group; other kinds stay distinct.
 */
export function groupActivities(activities: ActivityEntry[]): ActivityGroup[] {
  if (activities.length === 0) return [];
  const groups: ActivityGroup[] = [];
  for (const a of activities) {
    const stage = STAGE_FOR_KIND[a.kind];
    const prev = groups[groups.length - 1];
    // Merge when the stage is the same (reading+searching+inspecting → understanding).
    if (prev && prev.stage === stage) {
      if (a.detail) prev.targets.push(a.detail);
      if (a.count !== undefined) prev.counts.push(a.count);
    } else {
      groups.push({
        kind: a.kind,
        stage,
        targets: a.detail ? [a.detail] : [],
        counts: a.count !== undefined ? [a.count] : [],
        at: a.at,
      });
    }
  }
  return groups;
}

/**
 * Render a grouped activity as a single compact line.
 * Shows: "✓  Reading  5 files  ·  package.json, tsconfig.json, src/index.js"
 */
export function activityGroupLine(group: ActivityGroup, out: Output, unicode: boolean): string {
  const g = glyphs(unicode);
  const label = ACTIVITY_LABEL[group.kind] ?? group.kind;
  const parts: string[] = [out.gray(`  ${g.bullet}`), label];

  // Summarize counts.
  const total = group.counts.reduce((s, c) => s + c, 0);
  if (total > 0) {
    const suffix = group.kind === "searching" ? "result" : group.kind === "reading" ? "file" : "item";
    parts.push(out.gray(`${total} ${suffix}${total === 1 ? "" : "s"}`));
  }

  // Show up to 3 targets; collapse the rest.
  if (group.targets.length > 0) {
    const shown = group.targets.slice(0, 3).map((t) => out.gray(t));
    parts.push(out.gray(g.dot), shown.join(out.gray(", ")));
    if (group.targets.length > 3) {
      parts.push(out.gray(`+${group.targets.length - 3} more`));
    }
  }

  return parts.join(" ");
}

// ── Header ────────────────────────────────────────────────────────────────────

/** The session header: identity + the live facts a user steers by. */
export function headerLines(state: TerminalState, out: Output): string[] {
  const m = state.meta;
  if (!m) return [];
  const rows: Array<[string, string]> = [
    ["Project", `${m.projectName}  ${out.gray(m.workspacePath)}`],
  ];
  // Git state (from git.state event, or the session meta branch)
  if (state.git) {
    const g = state.git;
    const gitParts = [g.branch];
    if (g.dirty) gitParts.push("dirty");
    if (g.ahead > 0) gitParts.push(`+${g.ahead}`);
    if (g.behind > 0) gitParts.push(`-${g.behind}`);
    rows.push(["Branch", gitParts.join(" ")]);
  } else {
    rows.push(["Branch", m.branch]);
  }
  rows.push(["Model", `${m.provider} · ${m.model}  ${out.gray(m.privacy)}`]);
  rows.push(["Mode", m.mode]);
  rows.push(["Memory", m.memory ? "project context on" : "off"]);
  // Context usage
  if (state.contextUsage) {
    const u = state.contextUsage;
    const pct = u.maxTokens > 0 ? Math.round((u.usedTokens / u.maxTokens) * 100) : 0;
    rows.push(["Context", `${u.usedTokens}/${u.maxTokens} (${pct}%) · ${u.method}`]);
  }
  // Active agents
  const activeAgents = state.agents.filter((a) => a.status === "running");
  if (activeAgents.length > 0) {
    rows.push(["Agents", activeAgents.map((a) => `${a.name} (${a.role})`).join(", ")]);
  }
  // Background processes
  const runningProcs = state.processes.filter((p) => p.status === "running");
  if (runningProcs.length > 0) {
    rows.push(["Processes", `${runningProcs.length} running`]);
  }
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return rows.map(([k, v]) => `  ${out.gray((k + ":").padEnd(width + 1))} ${v}`);
}

// ── Tool card ─────────────────────────────────────────────────────────────────

/** A compact tool card: name, purpose, status, elapsed, provenance, result.
 *  Tool IDs are NEVER rendered — they're internal routing details. */
export function toolCardLines(card: ToolCard, out: Output, unicode: boolean, tick = 0, workspace?: string): string[] {
  const g = glyphs(unicode);
  const statusGlyph =
    card.status === "completed" ? out.green(g.ok) : card.status === "failed" ? out.red(g.fail) : out.gray(g.spinner[tick % g.spinner.length]!);
  const head = [`  ${statusGlyph} ${out.bold(card.name)}`];
  if (card.purpose) head.push(out.gray(`${g.dot} ${relativePath(card.purpose, workspace)}`));
  if (card.scope) head.push(out.gray(`${g.dot} ${relativePath(card.scope, workspace)}`));
  if (card.elapsedMs !== undefined) head.push(out.gray(`${g.dot} ${formatElapsed(card.elapsedMs)}`));
  const lines = [head.join(" ")];

  const tail: string[] = [];
  const appr = approvalLabel(card.approval);
  if (appr) tail.push(out.gray(appr));
  if (card.status === "failed" && card.error) {
    tail.push(out.red(truncate(card.error, 100)));
  } else if (card.summary) {
    tail.push(out.gray(truncate(relativePath(card.summary, workspace), 100)));
  }
  // Output reference is an internal detail; show it subtly but don't leak IDs.
  if (card.outputRef) tail.push(out.gray(`[output]`));
  if (tail.length) lines.push(`    ${g.arrow} ${tail.join("  ")}`);
  return lines;
}

// ── Activity (individual, for line renderer) ──────────────────────────────────

/** A single observable-activity line (never chain-of-thought). */
export function activityLine(entry: ActivityEntry, out: Output, unicode: boolean, workspace?: string): string {
  const g = glyphs(unicode);
  const label = ACTIVITY_LABEL[entry.kind];
  const parts = [out.gray(`  ${g.bullet} ${label}`)];
  if (entry.detail) parts.push(out.gray(relativePath(entry.detail, workspace)));
  if (entry.count !== undefined) parts.push(out.gray(`${g.dot} ${entry.count} result${entry.count === 1 ? "" : "s"}`));
  return parts.join(" ");
}

// ── Patch ─────────────────────────────────────────────────────────────────────

/** Patch summary: files, churn, provenance, applied/verification state. */
export function patchLines(patch: PatchEntry, out: Output, unicode: boolean, workspace?: string): string[] {
  const g = glyphs(unicode);
  const stateLabel = patch.applied ? out.green("applied") : out.yellow("proposed");
  const churn: string[] = [];
  if (patch.additions !== undefined) churn.push(out.green(`+${patch.additions}`));
  if (patch.deletions !== undefined) churn.push(out.red(`-${patch.deletions}`));
  const relFiles = patch.files.map((f) => relativePath(f, workspace));
  const head = `  ${g.bullet} patch ${stateLabel}  ${out.gray(relFiles.join(", "))}${churn.length ? "  " + churn.join(" ") : ""}`;
  const lines = [head];
  const tail: string[] = [];
  if (patch.explanation) tail.push(out.gray(truncate(patch.explanation, 100)));
  const appr = approvalLabel(patch.approval);
  if (appr) tail.push(out.gray(appr));
  if (tail.length) lines.push(`    ${g.arrow} ${tail.join("  ")}`);
  return lines;
}

// ── Completion summary ────────────────────────────────────────────────────────

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
 * Compose the full interactive frame: header, stage banner, a bounded
 * conversation tail, grouped activity, running tool cards, and a status
 * footer — clipped to the terminal size so the region math stays exact.
 * Pure and snapshot-testable.
 */
export function composeFrame(state: TerminalState, out: Output, unicode: boolean, opts: FrameOptions): string[] {
  const workspace = state.meta?.workspacePath;
  const lines: string[] = [];

  for (const l of headerLines(state, out)) lines.push(l);
  lines.push("");

  // Progress stage banner.
  const stage = stageBanner(state.progressStage, state.progressDetail, out, unicode);
  if (stage) {
    lines.push(stage);
    lines.push("");
  }

  // Conversation tail (labelled, one logical block per message).
  const convo: string[] = [];
  for (const entry of state.conversation) {
    const label = entry.role === "user" ? out.green("you › ") : out.magenta("morrow › ");
    const body = entry.text.length ? entry.text : entry.streaming ? out.gray("…") : "";
    for (const [i, raw] of body.split("\n").entries()) {
      convo.push((i === 0 ? label : "      ") + raw);
    }
  }

  // Grouped activity + running tool cards form the live region.
  const live: string[] = [];
  const groups = groupActivities(state.activity);
  // Show last 2 groups.
  for (const g of groups.slice(-2)) live.push(activityGroupLine(g, out, unicode));
  for (const card of state.tools.filter((t) => t.status === "running")) {
    for (const cl of toolCardLines(card, out, unicode, opts.tick, workspace)) live.push(cl);
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
