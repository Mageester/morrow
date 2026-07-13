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
import type { ActivityEntry, PatchEntry, RecoveryEntry, TerminalState, ToolCard } from "./state.js";

export type MorrowAvatarState = "idle" | "thinking" | "running-tool" | "completed" | "failed" | "paused";

export interface Glyphs {
  ok: string;
  fail: string;
  /** Current running action — a steady mark, not the animated spinner. */
  run: string;
  arrow: string;
  bullet: string;
  dot: string;
  warn: string;
  /** Active (in-progress) recovery — distinct from a bare failure (`fail`)
   *  or a still-open problem awaiting a strategy (`warn`). */
  recovering: string;
  /** A queued redirect/follow-up, visually distinct from both the activity
   *  feed and slash-command notices. */
  queued: string;
  /** The stable Morrow identity mark (state-independent). */
  mark: string;
  spinner: string[];
}

export function glyphs(unicode: boolean): Glyphs {
  return unicode
    ? { ok: "✓", fail: "✗", run: "●", arrow: "↳", bullet: "◦", dot: "·", warn: "!", recovering: "↻", queued: "↷", mark: "◇", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] }
    : { ok: "+", fail: "x", run: "*", arrow: ">", bullet: "-", dot: "-", warn: "!", recovering: "~", queued: ">>", mark: "*", spinner: ["-", "\\", "|", "/"] };
}

export function morrowAvatar(state: MorrowAvatarState, opts: { unicode: boolean; color: Output }): string {
  const out = opts.color;
  if (!opts.unicode) {
    if (state === "completed") return out.green("[M+]");
    if (state === "failed") return out.red("[M!]");
    if (state === "paused") return out.yellow("[M~]");
    if (state === "thinking" || state === "running-tool") return out.cyan("[M*]");
    return out.gray("[M]");
  }
  switch (state) {
    case "completed":
      return out.green("\u25C8M");
    case "failed":
      return out.red("\u25C7M!");
    case "paused":
      return out.yellow("\u25C7M~");
    case "thinking":
      return out.cyan("\u25C7M");
    case "running-tool":
      return out.cyan("\u25C9M");
    default:
      return out.gray("\u25C7M");
  }
}

/**
 * Every activity kind renders through the closed, beta.30 activity grammar —
 * Inspecting / Planning / Changing / Running / Verifying / Recovering /
 * Waiting / Blocked / Complete — so the default feed reads as meaningful
 * verbs, never raw tool-call telemetry (BETA30_CLI_ACCEPTANCE.md §6).
 */
const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  inspecting: "Inspecting",
  reading: "Inspecting",
  searching: "Inspecting",
  planning: "Planning",
  running: "Running",
  applying_patch: "Changing",
  verifying: "Verifying",
  waiting: "Waiting",
  retrying: "Recovering",
  delegating: "Running",
  completing: "Complete",
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
  editing: "Changing",
  running_checks: "Running checks",
  waiting_for_approval: "Waiting for approval",
  verifying: "Verifying",
  completed: "Complete",
  failed: "Blocked",
};

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "unknown";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(tokens);
}

export function plainMode(mode: string): "Ask" | "Plan" | "Build" {
  const lower = mode.toLowerCase();
  if (lower.includes("plan")) return "Plan";
  if (lower.includes("ask") || lower.includes("read-only") || lower.includes("inspect")) return "Ask";
  return "Build";
}

/**
 * The single source of truth for the displayed permission chip: computed
 * fresh from the *effective* mode + autoApprove flag every time, never from
 * an independently-derived string. Ask/Plan never show an autonomy word —
 * "YOLO"/"Auto-approved" can only ever appear while the effective mode is
 * Build. This is the fix for the confirmed defect where Plan mode rendered
 * "Plan · YOLO" because the chip was derived from the raw `autoApprove` flag
 * alone (KNOWN_ISSUES #2).
 */
export function permissionChip(mode: "Ask" | "Plan" | "Build", autoApprove: boolean): { text: string; auto: boolean } {
  if (mode === "Ask") return { text: "read-only", auto: false };
  if (mode === "Plan") return { text: "no changes", auto: false };
  return autoApprove ? { text: "Auto-approved", auto: true } : { text: "approval required", auto: false };
}

function autonomyLabel(state: TerminalState): string {
  if (!state.meta) return "approval required";
  return permissionChip(plainMode(state.meta.mode), Boolean(state.meta.autoApprove)).text;
}

function gitLabel(state: TerminalState): string {
  const g = state.git;
  if (!g) return state.meta?.branch ?? "unknown";
  let text = g.branch + (g.dirty ? "*" : "");
  if (g.ahead > 0) text += ` +${g.ahead}`;
  if (g.behind > 0) text += ` -${g.behind}`;
  if (g.dirty) text += " dirty";
  return text;
}

function usageLabel(state: TerminalState): string {
  const u = state.usage;
  if (!u) return "Tokens unknown";
  const parts = [`${formatTokens(u.inputTokens)} in`, `${formatTokens(u.outputTokens)} out`];
  if (u.cachedInputTokens > 0) parts.push(`${formatTokens(u.cachedInputTokens)} cached`);
  return `Tokens ${parts.join(" - ")}`;
}

function costLabel(state: TerminalState): string {
  const cost = state.usage?.estimatedCostUsd;
  if (cost === undefined || cost === null) return "Cost unknown";
  return `Cost $${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

/**
 * The real per-model context window for `state.contextUsage`, or `null`
 * when it's genuinely unknown (never a guessed/generic/preset-only number).
 * The single source of truth for this — `/context`, `/status`, and `/stats`
 * (`contextLabel`, below) must all read this instead of recomputing their
 * own version, so they can never contradict each other.
 */
export function contextLimit(state: TerminalState): number | null {
  const u = state.contextUsage;
  if (!u) return null;
  if (u.contextLimitTokens !== undefined) return u.contextLimitTokens;
  return u.contextWindowSource === "fallback" ? null : u.maxTokens;
}

function contextLabel(state: TerminalState): string {
  const u = state.contextUsage;
  if (!u) return "Context unknown";
  const limit = contextLimit(state);
  if (!limit || limit <= 0) return `Context ${formatTokens(u.usedTokens)} / unknown`;
  const pct = u.percent ?? Math.round((u.usedTokens / limit) * 100);
  return `Context ${formatTokens(u.usedTokens)} / ${formatTokens(limit)} - ${pct}%`;
}

function toolsLabel(state: TerminalState): string {
  const failed = state.tools.filter((t) => t.status === "failed").length;
  return `Tools ${state.tools.length} calls - ${failed} failed`;
}

function taskLabel(state: TerminalState): string {
  return state.status === "streaming" ? "running" : state.status;
}

function liveStateLabel(state: TerminalState): string {
  if (state.status === "streaming") return "working";
  if (state.status === "completed") return "ready";
  if (state.status === "failed") return "failed";
  if (state.status === "cancelled" || state.status === "interrupted" || state.status === "budget-reached" || state.status === "stalled") return state.status;
  return "idle";
}

function agentsLabel(state: TerminalState): string | null {
  const running = state.agents.filter((agent) => agent.status === "running");
  if (running.length === 0) return null;
  return `Agents ${running.map((agent) => agent.name).join(", ")}`;
}

function processesLabel(state: TerminalState): string | null {
  const running = state.processes.filter((process) => process.status === "running");
  if (running.length === 0) return null;
  return `Processes ${running.length} running`;
}

function avatarState(state: TerminalState): MorrowAvatarState {
  if (state.status === "failed") return "failed";
  if (state.status === "stalled" || state.status === "budget-reached") return "paused";
  if (state.status === "completed") return "completed";
  // A tool card can be left "running" after the stream itself has ended
  // (pause, cancel, interrupt) — only show the live/running-tool avatar
  // while genuinely streaming, never for an abandoned call's stale status.
  if (state.status === "streaming" && state.tools.some((t) => t.status === "running")) return "running-tool";
  if (state.status === "streaming") return "thinking";
  return "idle";
}

function joinHeaderFields(out: Output, fields: string[], unicode: boolean): string {
  return fields.filter(Boolean).join(out.gray(` ${glyphs(unicode).dot} `));
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
/** Human label for a progress stage (e.g. "understanding" → "Understanding project"). */
export function stageLabel(stage: ProgressStage): string {
  return STAGE_LABEL[stage] ?? stage;
}

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
 * Collapse a flat activity list into one group per meaningful stage.
 * "reading" + "searching" + "inspecting" all merge into the "understanding"
 * stage even when another phase briefly intervenes, so `/activity` is a
 * concise phase summary rather than a repeated telemetry transcript.
 */
export function groupActivities(activities: ActivityEntry[]): ActivityGroup[] {
  if (activities.length === 0) return [];
  const groups: ActivityGroup[] = [];
  for (const a of activities) {
    const stage = STAGE_FOR_KIND[a.kind];
    const existing = groups.find((group) => group.stage === stage);
    // Merge all observations belonging to the same user-facing phase.
    if (existing) {
      if (a.detail) existing.targets.push(a.detail);
      if (a.count !== undefined) existing.counts.push(a.count);
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

export interface HeaderOptions {
  unicode?: boolean;
  columns?: number;
  elapsedMs?: number;
}

/** `branch · clean` / `branch · dirty` — the two git facts a user steers by.
 *  Ahead/behind and file lists live in /branch and /stats. */
function gitShortLabel(state: TerminalState): string | null {
  const g = state.git;
  if (g) return `${g.branch} ${DOT} ${g.dirty ? "dirty" : "clean"}`;
  return state.meta?.branch ?? null;
}

const DOT = "·";

/**
 * The session header — identity only, one fact per line, nothing the footer
 * or /stats already owns:
 *
 *   ◇ MORROW
 *   ProjectName · branch · clean
 *   model · Build · YOLO
 *
 * Narrow terminals keep the project and the mode (the footer keeps task
 * state); everything else collapses. Detailed metrics live in /stats.
 */
export function headerLines(state: TerminalState, out: Output, opts: HeaderOptions = {}): string[] {
  const m = state.meta;
  if (!m) return [];
  const unicode = opts.unicode ?? true;
  const columns = opts.columns ?? 80;
  const g = glyphs(unicode);
  const dot = out.gray(` ${g.dot} `);
  const mode = plainMode(m.mode);
  const perm = permissionChip(mode, Boolean(m.autoApprove));
  const modeChip = `${out.cyan(mode)}${dot}${perm.auto ? out.yellow(perm.text) : out.gray(perm.text)}`;
  const git = gitShortLabel(state);

  if (columns < 56) {
    return [
      clipToWidth(`  ${g.mark} ${out.bold("MORROW")}${dot}${out.cyan(m.projectName)}`, columns),
      clipToWidth(`  ${modeChip}`, columns),
    ];
  }

  const gitPart = git ? `${dot}${out.gray(git.replace(/ · /g, ` ${g.dot} `))}` : "";
  return [
    `  ${g.mark} ${out.bold("MORROW")}`,
    clipToWidth(`  ${out.cyan(m.projectName)}${gitPart}`, columns),
    clipToWidth(`  ${out.gray(m.model)}${dot}${modeChip}`, columns),
  ];
}

// ── /stats — the detailed statistics view ─────────────────────────────────────

export interface StatsOptions {
  unicode?: boolean;
  elapsedMs?: number;
}

/**
 * Every detailed metric that used to crowd the header, in one place, honest
 * about unknowns. This is the single owner of tokens, context, cost, memory,
 * the full provider/model identifier, tool totals, agents, and processes.
 */
export function statsLines(state: TerminalState, out: Output, opts: StatsOptions = {}): string[] {
  const m = state.meta;
  const g = glyphs(opts.unicode ?? true);
  const dot = ` ${g.dot} `;
  const rows: Array<[string, string]> = [];

  if (m) {
    rows.push(["model", `${m.provider}/${m.model}${dot}${m.privacy}`]);
    rows.push(["mode", `${plainMode(m.mode)}${dot}${autonomyLabel(state)}`]);
    rows.push(["memory", m.memory ? "on" : "off"]);
  }
  const u = state.usage;
  rows.push(["tokens", u ? [`${formatTokens(u.inputTokens)} in`, `${formatTokens(u.outputTokens)} out`, ...(u.cachedInputTokens > 0 ? [`${formatTokens(u.cachedInputTokens)} cached`] : [])].join(dot) : "unknown"]);
  const cu = state.contextUsage;
  if (cu) {
    const limit = contextLimit(state);
    const pct = limit && limit > 0 ? `${cu.percent ?? Math.round((cu.usedTokens / limit) * 100)}%` : null;
    rows.push(["context", `${formatTokens(cu.usedTokens)} / ${limit ? formatTokens(limit) : "unknown"}${pct ? dot + pct : ""}${dot}${cu.method}`]);
  } else {
    rows.push(["context", "unknown"]);
  }
  const cost = state.usage?.estimatedCostUsd;
  rows.push(["cost", cost === undefined || cost === null ? "unknown (not metered)" : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`]);
  const failed = state.tools.filter((t) => t.status === "failed").length;
  rows.push(["tools", `${state.tools.length} calls${dot}${failed} failed`]);
  if (opts.elapsedMs !== undefined) rows.push(["time", formatElapsed(opts.elapsedMs)]);
  if (state.git) {
    const gi = state.git;
    const bits = [gi.branch, gi.dirty ? "dirty" : "clean"];
    if (gi.ahead > 0) bits.push(`+${gi.ahead} ahead`);
    if (gi.behind > 0) bits.push(`-${gi.behind} behind`);
    rows.push(["git", bits.join(dot)]);
  }
  const runningAgents = state.agents.filter((a) => a.status === "running").length;
  if (runningAgents > 0) rows.push(["agents", `${runningAgents} running`]);
  const runningProcs = state.processes.filter((p) => p.status === "running").length;
  if (runningProcs > 0) rows.push(["processes", `${runningProcs} running`]);
  if (m) rows.push(["workspace", m.workspacePath]);

  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return [out.bold("Session statistics"), "", ...rows.map(([k, v]) => `  ${out.gray(k.padEnd(width + 2))}${v}`)];
}

// ── Tool card ─────────────────────────────────────────────────────────────────

/** A compact tool card: name, purpose, status, elapsed, provenance, result.
 *  Tool IDs are NEVER rendered — they're internal routing details. */
export function toolCardLines(card: ToolCard, out: Output, unicode: boolean, tick = 0, workspace?: string): string[] {
  const g = glyphs(unicode);
  const statusGlyph =
    card.status === "completed" ? out.green(g.ok) : card.status === "failed" ? out.red(g.fail) : out.gray(g.spinner[tick % g.spinner.length]!);
  const head = [`  ${statusGlyph} ${out.bold(card.name)}`];
  const relPurpose = card.purpose ? relativePath(card.purpose, workspace) : null;
  const relScope = card.scope ? relativePath(card.scope, workspace) : null;
  if (relPurpose) head.push(out.gray(`${g.dot} ${relPurpose}`));
  // Only show scope when it adds new info beyond purpose
  if (relScope && relScope !== relPurpose) head.push(out.gray(`${g.dot} ${relScope}`));
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

// ── Structured actions ────────────────────────────────────────────────────────

/** Present/past verbs per tool, so live output reads as actions, not narration.
 *  The present tense (index 0) is one of the closed activity-grammar verbs
 *  (BETA30_CLI_ACCEPTANCE.md §6); the past tense stays tool-specific for the
 *  completed-action log, which is a historical record, not a live verb. */
const TOOL_VERBS: Record<string, [present: string, past: string]> = {
  read_file: ["Inspecting", "Read"],
  create_file: ["Changing", "Created"],
  create_directory: ["Changing", "Created"],
  delete_file: ["Changing", "Deleted"],
  edit_file: ["Changing", "Edited"],
  propose_patch: ["Changing", "Edited"],
  apply_patch: ["Changing", "Patched"],
  run_command: ["Running", "Ran"],
  search_text: ["Inspecting", "Searched"],
  search_files: ["Inspecting", "Searched"],
  list_files: ["Inspecting", "Listed"],
  inspect_workspace: ["Inspecting", "Inspected"],
};

function toolVerb(name: string, tense: 0 | 1): string {
  const verbs = TOOL_VERBS[name];
  if (verbs) return verbs[tense];
  return tense === 0 ? name : name;
}

/** The present-tense verb for a running tool card. A command flagged as a
 *  verification step reads as "Verifying", not "Running" — the grammar
 *  distinguishes executing a check from executing an ordinary command. */
function presentVerb(card: ToolCard): string {
  if (card.verification) return "Verifying";
  return toolVerb(card.name, 0);
}

function toolTarget(card: ToolCard, workspace?: string): string {
  if (card.name === "inspect_workspace") return "workspace";
  const raw = card.purpose ?? card.scope ?? "";
  return raw ? truncate(relativePath(raw, workspace), 60) : "";
}

/**
 * One structured line per completed observable action:
 *   ✓ Read verify.js
 *   ✓ Ran pnpm test
 * Failed tools are owned by the recovery lines and skipped here.
 */
export function actionLine(card: ToolCard, out: Output, unicode: boolean, workspace?: string): string | null {
  const g = glyphs(unicode);
  if (card.status === "failed") return null;
  const target = toolTarget(card, workspace);
  if (card.status === "running") {
    return `  ${out.cyan(g.spinner[0]!)} ${presentVerb(card)}${target ? " " + target : ""}`;
  }
  return `  ${out.green(g.ok)} ${toolVerb(card.name, 1)}${target ? " " + out.gray(target) : ""}`;
}

/** The running-tool line with a live spinner tick. */
export function runningActionLine(card: ToolCard, out: Output, unicode: boolean, tick: number, workspace?: string): string {
  const g = glyphs(unicode);
  const target = toolTarget(card, workspace);
  return `  ${out.cyan(g.spinner[tick % g.spinner.length]!)} ${presentVerb(card)}${target ? " " + target : ""}`;
}

// ── Recovery lines ────────────────────────────────────────────────────────────

/**
 * Render one recovery entry as its structured story — what failed, what
 * strategy was used, and the explicit outcome — never a bare "Recovered"
 * with no detail (KNOWN_ISSUES #4):
 *
 *   ! Recovering  Patch mismatch ×2
 *     Switched to full-file rewrite — succeeded
 *
 * "Recovering" is the closed-grammar verb for this event kind
 * (BETA30_CLI_ACCEPTANCE.md §6); warning styling while recoverable, red only
 * when the task itself ultimately failed.
 */
export function recoveryEntryLines(entry: RecoveryEntry, out: Output, unicode: boolean, taskFailed: boolean): string[] {
  const g = glyphs(unicode);
  const count = entry.count > 1 ? ` ${unicode ? "×" : "x"}${entry.count}` : "";
  const problem = truncate(entry.message, 80) + count;

  // A recovery the task never resolved before ending — whether it never
  // progressed past "failed" or was still "retrying" (a strategy switch was
  // in flight) when the task itself failed. Still show the attempted
  // strategy when one is known, and always state the outcome explicitly as
  // "failed" — never silently drop the story just because it didn't work
  // out, and never fabricate a strategy that was never reported.
  if (taskFailed && entry.status !== "recovered") {
    const lines = [`  ${out.red(g.fail)} ${out.red(problem)}`];
    const hasStrategy = Boolean(entry.strategy && entry.strategy !== entry.message);
    lines.push(
      hasStrategy
        ? `    ${out.gray(truncate(entry.strategy!, 80))} ${out.gray("—")} ${out.red("failed")}`
        : `    ${out.red("failed")}`,
    );
    return lines;
  }

  // A bare, freshly-reported problem (no strategy chosen yet) reads as a
  // failure (✗) — the same mark a failed action gets elsewhere. Only once a
  // strategy is in flight does this become an *active* recovery (↻); once it
  // resolves, a success (✓).
  const glyph = entry.status === "recovered" ? out.green(g.ok) : entry.status === "retrying" ? out.yellow(g.recovering) : out.red(g.fail);
  const colorize = (s: string) => (entry.status === "recovered" ? out.green(s) : entry.status === "retrying" ? out.yellow(s) : out.red(s));
  const verb = entry.status === "recovered" || entry.status === "retrying" ? "Recovering" : "Failed";
  const lines = [`  ${glyph} ${colorize(verb)}  ${colorize(problem)}`];

  // The strategy/outcome line only appears once a strategy exists or the
  // problem resolved — a bare, freshly-reported failure has no strategy yet
  // and is not yet an outcome, so it stays a single line until there is a
  // real second fact to add. This keeps each stage transition (reported →
  // retrying → recovered) an honest single line for non-interactive callers
  // that print only the newly-reached stage.
  const hasStrategy = Boolean(entry.strategy && entry.strategy !== entry.message);
  if (hasStrategy || entry.status === "recovered") {
    const outcome = entry.status === "recovered" ? "succeeded" : entry.status === "retrying" ? "in progress" : "failed";
    const outcomeText = entry.status === "recovered" ? out.green(outcome) : out.gray(outcome);
    lines.push(hasStrategy ? `    ${out.gray(truncate(entry.strategy!, 80))} ${out.gray("—")} ${outcomeText}` : `    ${outcomeText}`);
  }
  return lines;
}

// ── Completion card ───────────────────────────────────────────────────────────

export interface CompletionCardOptions {
  unicode?: boolean;
  elapsedMs?: number;
  /** Terminal width, for wrapping (never truncating) long messages. */
  columns?: number;
}

/**
 * The compact end-of-task card. Answers, in order: did it succeed, what
 * changed, did verification pass, what was recovered — then where the full
 * report lives. Never dumps the full report into the transcript.
 */
/**
 * A real, evidence-backed commit — never fabricated or guessed. Only
 * matches a completed `git commit` command, and only reports a sha actually
 * present in that command's own reported output (git's own
 * `[branch sha] message` line, or a bare hex token), never a sha invented
 * because a commit command merely looked like it ran. The message, when
 * shown, comes from the command's own `-m` argument — the real text Morrow
 * passed to git, not a paraphrase. Absent either signal, this returns
 * `null` and the completion card simply omits the section, the same as
 * "Changed"/"Verified"/"Recovered" do when they have nothing to report.
 */
function commitInfo(state: TerminalState): { sha: string; message?: string } | null {
  const card = [...state.tools].reverse().find(
    (t) => t.name === "run_command" && t.status === "completed" && /(^|[;&|]\s*)git\s+commit\b/.test(t.purpose ?? ""),
  );
  if (!card) return null;
  const purpose = card.purpose ?? "";
  const msgMatch = purpose.match(/-m\s+"([^"]+)"/) ?? purpose.match(/-m\s+'([^']+)'/);
  const summary = card.summary ?? "";
  const shaMatch = summary.match(/\[[^\]]*?\s([0-9a-f]{7,40})\]/) ?? summary.match(/\b([0-9a-f]{7,40})\b/);
  if (!shaMatch) return null;
  return { sha: shaMatch[1]!, ...(msgMatch ? { message: msgMatch[1]! } : {}) };
}

export function completionCard(state: TerminalState, out: Output, opts: CompletionCardOptions = {}): string[] {
  const unicode = opts.unicode ?? true;
  const g = glyphs(unicode);
  const dot = ` ${g.dot} `;
  const lines: string[] = [];
  const totals = `${state.tools.length} tool${state.tools.length === 1 ? "" : "s"}${opts.elapsedMs !== undefined ? dot + formatElapsed(opts.elapsedMs) : ""}`;

  if (state.status === "completed") {
    lines.push(`  ${out.green(g.ok)} ${out.green("Task completed")}`);
    const files = [...new Set(state.patches.filter((p) => p.applied).flatMap((p) => p.files))];
    if (files.length > 0) {
      lines.push(`  ${out.bold("Changed")}`);
      for (const f of files.slice(0, 8)) lines.push(`    ${f}`);
      if (files.length > 8) lines.push(`    ${out.gray(`+${files.length - 8} more`)}`);
    }
    const verify = [...state.tools].reverse().find((tool) =>
      tool.name === "run_command" &&
      tool.status === "completed" &&
      tool.verification === true &&
      /^exit 0(?:\b|$)/i.test(tool.summary ?? ""),
    );
    if (verify) {
      lines.push(`  ${out.bold("Verified")}`);
      const detail = verify.summary ? dot + truncate(verify.summary, 48) : "";
      lines.push(`    ${truncate(toolTarget(verify) || "command", 48)}${out.gray(detail)}`);
    }
    const commit = commitInfo(state);
    if (commit) {
      lines.push(`  ${out.bold("Commit")}`);
      lines.push(`    ${commit.sha}${commit.message ? dot + truncate(commit.message, 60) : ""}`);
    }
    const recovered = state.recoveries.filter((r) => r.status === "recovered");
    if (recovered.length > 0) {
      lines.push(`  ${out.bold("Recovered")}`);
      for (const r of recovered.slice(0, 4)) {
        const count = r.count > 1 ? ` ${unicode ? "×" : "x"}${r.count}` : "";
        lines.push(`    ${truncate(r.message, 60)}${count}`);
      }
    }
    lines.push(`  ${out.gray(totals)}`, `  ${out.gray("Details:")} ${out.cyan("/output")}`);
    return lines;
  }

  if (state.status === "failed") {
    lines.push(`  ${out.red(g.fail)} ${out.red("Task failed")}`);
    if (state.lastError) {
      lines.push(`  ${out.bold("Blocked by")}`);
      for (const l of wrapText(state.lastError, Math.max(20, (opts.columns ?? 80) - 6))) lines.push(`    ${l}`);
    }
    const lastOk = [...state.tools].reverse().find((t) => t.status === "completed");
    if (lastOk) {
      lines.push(`  ${out.bold("Last successful step")}`, `    ${toolVerb(lastOk.name, 1)} ${toolTarget(lastOk)}`);
    }
    const next = state.recoverySuggestions[state.recoverySuggestions.length - 1];
    lines.push(`  ${out.bold("Next action")}`, `    ${next ?? "Retry with /continue, or review the full trail"}`);
    lines.push(`  ${out.gray(totals)}`, `  ${out.gray("Details:")} ${out.cyan("/output full")}`);
    return lines;
  }

  if (state.status === "stalled" || state.status === "budget-reached") {
    // One shared "Paused" shape for every pause reason — never a spinner,
    // an elapsed timer, or "still working" text, and never a second,
    // differently-worded chip implying something other than paused.
    lines.push(`  ${out.yellow(g.warn)} ${out.yellow("Paused")}`);
    lines.push(...labelWithWrappedText("Reason:", state.lastError ?? "the task stopped making progress", out, opts.columns ?? 80));
    lines.push(`  ${out.bold("Next:")} ${out.cyan("/continue")}`);
    lines.push(`  ${out.gray(totals)}`, `  ${out.gray("Details:")} ${out.cyan("/output full")}`);
    return lines;
  }

  // Cancelled / interrupted: one calm line plus the report pointer.
  const label = state.status === "cancelled" ? "Task cancelled" : "Task interrupted";
  lines.push(`  ${out.yellow(g.warn)} ${out.yellow(label)}`, `  ${out.gray(totals)}`, `  ${out.gray("Details:")} ${out.cyan("/output")}`);
  return lines;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/**
 * Word-wrap text to a column budget without ellipsizing — the final-result
 * view must never destructively truncate an important message. A single word
 * longer than the budget is hard-broken so it still can't force an overflow.
 */
export function wrapText(s: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const words = flat.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= safeWidth) current += " " + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.flatMap((line) => {
    if (line.length <= safeWidth) return [line];
    const chunks: string[] = [];
    for (let i = 0; i < line.length; i += safeWidth) chunks.push(line.slice(i, i + safeWidth));
    return chunks;
  });
}

/**
 * A bold `label` followed by wrapped body text: inline on one line when it
 * fits the column budget (preserving the compact single-line look for the
 * common short case), or the label alone with wrapped, indented continuation
 * lines when it doesn't — never a hard, ellipsized cut.
 */
function labelWithWrappedText(label: string, text: string, out: Output, width: number): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  const inline = `  ${out.bold(label)} ${flat}`;
  if (stripAnsi(inline).length <= width) return [inline];
  return [`  ${out.bold(label)}`, ...wrapText(flat, Math.max(20, width - 6)).map((l) => `    ${l}`)];
}

/**
 * Break a plain (uncolored) line into chunks of at most `width` characters,
 * never dropping a character — unlike `clipToWidth`, which truncates. For
 * content that must survive intact outside the repaint loop (e.g. a report
 * written once into real terminal scrollback), this is the safe way to keep
 * every row within the terminal's width without relying on the terminal's
 * own auto-wrap, which can interact badly with a following cursor move.
 */
export function hardWrapLine(line: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  if (line.length === 0) return [""];
  if (line.length <= safeWidth) return [line];
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += safeWidth) chunks.push(line.slice(i, i + safeWidth));
  return chunks;
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

  for (const l of headerLines(state, out, { unicode, columns: opts.columns })) lines.push(l);
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

  // Structured actions + recovery stories + running tools form the live region.
  const live: string[] = [];
  const taskFailed = state.status === "failed";
  for (const entry of state.recoveries.slice(-3)) for (const rl of recoveryEntryLines(entry, out, unicode, taskFailed)) live.push(rl);
  for (const card of state.tools.filter((t) => t.status === "running")) {
    live.push(runningActionLine(card, out, unicode, opts.tick, workspace));
  }

  const footer = statusFooter(state, out, unicode, opts.columns, opts.hint);

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

function statusFooter(state: TerminalState, out: Output, unicode: boolean, columns: number, hint?: string): string[] {
  const bar = statusBar(state, out, unicode, columns);
  return hint ? [bar, out.gray(`  ${hint}`)] : [bar];
}

// ── Current action ────────────────────────────────────────────────────────────

/**
 * The one-phrase answer to "what is Morrow doing right now": the running
 * tool as a verb + target ("editing verify.js"), else the latest activity,
 * else "thinking" while streaming.
 */
export function currentActionLabel(state: TerminalState, workspace?: string): string | null {
  const running = [...state.tools].reverse().find((t) => t.status === "running");
  if (running) {
    const target = toolTarget(running, workspace);
    return `${presentVerb(running).toLowerCase()}${target ? " " + target : ""}`;
  }
  if (state.status !== "streaming") return null;
  const latest = state.activity[state.activity.length - 1];
  if (latest) {
    const label = ACTIVITY_LABEL[latest.kind] ?? latest.kind;
    return latest.detail ? `${label} ${truncate(relativePath(latest.detail, workspace), 40)}` : label;
  }
  return "thinking";
}

// ── Status bar (footer) ───────────────────────────────────────────────────────

export interface StatusBarOptions {
  elapsedMs?: number;
}

/**
 * The compact footer — one line, one job: what is Morrow doing right now?
 *
 *   ◇ Morrow · ready
 *   ◇ Morrow · editing verify.js
 *   ◇ Morrow · ready · last task passed
 *
 * The only extra chip is a context warning at ≥70% (the point where the user
 * should care). Everything else lives in the header or /stats.
 */
export function statusBar(state: TerminalState, out: Output, unicode: boolean, columns: number, opts: StatusBarOptions = {}): string {
  const g = glyphs(unicode);
  const sep = out.gray(` ${g.dot} `);
  const avatar = morrowAvatar(avatarState(state), { unicode, color: out });
  const workspace = state.meta?.workspacePath;
  const parts: Array<{ plain: string; render: string; priority: number }> = [];
  const push = (plain: string, render: string, priority: number) => parts.push({ plain, render, priority });

  push(stripAnsi(avatar), avatar, 100);
  push("Morrow", out.bold("Morrow"), 10);

  if (state.status === "streaming") {
    const action = currentActionLabel(state, workspace) ?? "working";
    const withTimer = opts.elapsedMs !== undefined ? `${action} ${g.dot} ${formatElapsed(opts.elapsedMs)}` : action;
    push(withTimer, out.cyan(withTimer), 90);
  } else {
    const isPaused = state.status === "stalled" || state.status === "budget-reached";
    const readyLabel = isPaused ? "paused" : "ready";
    push(readyLabel, isPaused ? out.yellow(readyLabel) : state.status === "idle" ? out.gray(readyLabel) : out.green(readyLabel), 30);
    // A paused state is fully said by the "paused" chip above — a second
    // chip repeating "budget reached"/"last task paused" right beside it
    // read as two contradictory facts, not one. The specific reason lives
    // in the completion card and /status, not the compact footer.
    if (state.status === "completed") push("last task passed", out.gray("last task passed"), 80);
    else if (state.status === "failed") push("last task failed", out.red("last task failed"), 80);
    else if (state.status === "cancelled") push("last task cancelled", out.yellow("last task cancelled"), 80);
    else if (state.status === "interrupted") push("last task interrupted", out.yellow("last task interrupted"), 80);
  }

  // The single warning chip: context pressure the user must know about.
  const cu = state.contextUsage;
  const limit = cu ? (cu.contextLimitTokens ?? (cu.contextWindowSource === "fallback" ? null : cu.maxTokens)) : null;
  if (cu && limit && limit > 0) {
    const pct = cu.percent ?? Math.round((cu.usedTokens / limit) * 100);
    if (pct >= 70) {
      const label = `ctx ${pct}%`;
      push(label, pct >= 90 ? out.red(label) : out.yellow(label), 40);
    }
  }

  const budget = Number.isFinite(columns) ? Math.max(0, columns - 2) : Number.POSITIVE_INFINITY;
  const width = (fs: typeof parts) => fs.reduce((w, f) => w + f.plain.length, 0) + Math.max(0, fs.length - 1) * ` ${g.dot} `.length;
  let kept = [...parts];
  while (kept.length > 2 && width(kept) > budget) {
    const removable = kept.reduce((lowest, part, index) => part.priority < kept[lowest]!.priority ? index : lowest, 1);
    kept.splice(removable, 1);
  }
  if (kept.length === 2 && width(kept) > budget) {
    const available = Math.max(1, budget - kept[0]!.plain.length - ` ${g.dot} `.length);
    const clipped = clipToWidth(kept[1]!.render, available);
    kept[1] = { ...kept[1]!, plain: stripAnsi(clipped), render: clipped };
  }
  return "  " + kept.map((f) => f.render).join(sep);
}
