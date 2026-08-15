/**
 * Pure Mission Deck side-rail views.
 *
 * The rail is deliberately derived from facts already present in
 * `TerminalState`. It is a visual index of the current mission, not a second
 * source of truth and never a place to invent timestamps, file sizes, or
 * verification claims.
 */
import type { Output } from "../cli/output.js";
import type { PlanEntry, TerminalState } from "./state.js";
import { currentActionLabel, glyphs, groupActivities, permissionChip, plainMode, relativePath, wrapText } from "./view.js";

const DOT = "\u00b7";

function sentenceCase(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return "New mission";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function titleCasePhrase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9][A-Z0-9+.#/-]*$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(" ");
}

/** Derive a display-only mission title while keeping the original request intact in the transcript. */
export function missionTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  const repositoryMatch = clean.match(/^turn (?:this )?(?:repository|repo|project) into (?:a |an )?(.+)$/i);
  if (repositoryMatch?.[1]) return `Repository \u2192 ${titleCasePhrase(repositoryMatch[1])}`;
  return sentenceCase(clean);
}

function latestUserRequest(state: TerminalState): string | null {
  for (let index = state.conversation.length - 1; index >= 0; index -= 1) {
    const entry = state.conversation[index];
    if (entry?.role === "user" && entry.text.trim()) return entry.text.trim();
  }
  return null;
}

function focusLabel(state: TerminalState, workspace?: string): string {
  if (state.status === "streaming") return currentActionLabel(state, workspace) ?? "thinking";
  if (state.status === "completed") return "Review result";
  if (state.status === "failed" || state.status === "stalled" || state.status === "budget-reached") return "Task blocked";
  if (state.status === "cancelled" || state.status === "interrupted") return "Task paused";
  return "Ready for a new mission";
}

function planStatusLabel(status: PlanEntry["status"]): string {
  switch (status) {
    case "completed": return "done";
    case "running": return "running";
    case "failed": return "failed";
    case "skipped": return "skipped";
    default: return "pending";
  }
}

function planMarker(status: PlanEntry["status"], out: Output, unicode: boolean): string {
  const g = glyphs(unicode);
  switch (status) {
    case "completed": return out.sage(g.ok);
    case "running": return out.copper(g.run);
    case "failed": return out.red(g.fail);
    default: return out.gray(unicode ? "○" : "o");
  }
}

function wrapRailText(text: string, width: number, indent = "  "): string[] {
  const rows = wrapText(text, Math.max(12, width));
  return rows.map((row, index) => index === 0 ? row : indent + row);
}

function observedArtifacts(state: TerminalState, workspace?: string): string[] {
  const files = new Set<string>();
  for (const patch of state.patches) {
    for (const file of patch.files) files.add(relativePath(file, workspace));
  }
  return [...files];
}

function observedReferences(state: TerminalState, workspace?: string): string[] {
  const names = new Set<string>();
  const referenceTools = new Set(["read_file", "search_files", "search_text", "list_files", "inspect_workspace"]);
  for (const tool of state.tools) {
    if (!referenceTools.has(tool.name)) continue;
    const target = tool.purpose ?? tool.scope;
    if (target) names.add(relativePath(target, workspace));
  }
  for (const activity of state.activity) {
    if (activity.detail && (activity.kind === "reading" || activity.kind === "searching" || activity.kind === "inspecting")) {
      names.add(relativePath(activity.detail, workspace));
    }
  }
  return [...names];
}

function pushSection(lines: string[], title: string, out: Output): void {
  lines.push("", out.gray(title));
}

function timelineLabel(title: string): string {
  const lower = title.toLowerCase();
  if (/(inspect|read|scan|understand)/.test(lower)) return "Inspecting";
  if (/(plan|outline|design)/.test(lower)) return "Planning";
  if (/(change|edit|write|create|implement)/.test(lower)) return "Changing";
  if (/(verify|test|check|validate)/.test(lower)) return "Verifying";
  if (/(run|execute|build)/.test(lower)) return "Running";
  return title;
}

/** Render plan-backed progress as the connected stage timeline from the
 * reference. Plan status is authoritative; no stage is marked complete from
 * a merely observed tool call. */
export function buildMissionTimelineLines(state: TerminalState, out: Output, unicode: boolean, columns: number): string[] {
  const rows = state.plan.length > 0
    ? state.plan.map((step) => ({ label: timelineLabel(step.title), detail: step.title, status: step.status }))
    : groupActivities(state.activity).map((group, index, groups) => ({
      label: group.kind === "reading" || group.kind === "searching" || group.kind === "inspecting" ? "Inspecting" : group.stage === "verifying" ? "Verifying" : group.stage === "planning" ? "Planning" : group.stage === "editing" ? "Changing" : "Running",
      detail: group.targets.join(", "),
      status: state.status === "streaming" && index === groups.length - 1 ? "running" as const : "completed" as const,
    }));
  if (rows.length === 0) return [];

  const width = Math.max(20, columns - 14);
  const lines: string[] = [];
  for (const [index, row] of rows.entries()) {
    const marker = planMarker(row.status, out, unicode);
    const label = row.status === "running" ? out.copper(row.label) : out.gray(row.label);
    const plainFirst = `${row.label}${row.detail ? `  ${row.detail}` : ""}`;
    const wrapped = wrapText(plainFirst, width);
    const firstRow = wrapped[0] ?? row.label;
    const suffix = firstRow.slice(row.label.length);
    lines.push(`  ${marker} ${label}${suffix ? out.gray(suffix) : ""}`);
    for (const continuation of wrapped.slice(1)) lines.push(`    ${continuation}`);
    if (index < rows.length - 1) lines.push(`  ${out.gray("│")}`);
  }
  return lines;
}

/** Render the fixed right rail used by wide Mission Deck frames. */
export function buildLiveWorkLines(state: TerminalState, out: Output, unicode: boolean, columns: number, workspace?: string): string[] {
  const width = Math.max(16, columns);
  const lines: string[] = [out.bold("LIVE WORK")];
  const focus = focusLabel(state, workspace);
  lines.push("", out.gray("Focus"), ...wrapRailText(focus, width, "  ").map((line) => out.copper(line)));

  pushSection(lines, "Plan", out);
  if (state.plan.length === 0) {
    lines.push(out.gray("  No plan recorded"));
  } else {
    for (const [index, step] of state.plan.entries()) {
      const prefix = `${index + 1}. `;
      const status = `${DOT} ${planStatusLabel(step.status)}`;
      const rows = wrapRailText(`${prefix}${step.title}`, Math.max(12, width - 12));
      lines.push(`${planMarker(step.status, out, unicode)} ${rows[0]}${out.gray(`  ${status}`)}`);
      for (const row of rows.slice(1)) lines.push(`   ${row}`);
    }
  }

  pushSection(lines, "Artifacts", out);
  const artifacts = observedArtifacts(state, workspace);
  if (artifacts.length === 0) {
    lines.push(out.gray("  None recorded"));
  } else {
    for (const file of artifacts.slice(0, 5)) lines.push(...wrapRailText(file, Math.max(12, width - 2)).map((row) => `  ${row}`));
    if (artifacts.length > 5) lines.push(out.gray(`  +${artifacts.length - 5} more`));
  }

  pushSection(lines, "References", out);
  const references = observedReferences(state, workspace);
  if (references.length === 0) {
    lines.push(out.gray("  None recorded"));
  } else {
    for (const file of references.slice(0, 5)) lines.push(...wrapRailText(file, Math.max(12, width - 2)).map((row) => `  ${row}`));
    if (references.length > 5) lines.push(out.gray(`  +${references.length - 5} more`));
  }

  pushSection(lines, "Permissions", out);
  const mode = plainMode(state.meta?.mode ?? "Build");
  const permission = permissionChip(mode, Boolean(state.meta?.autoApprove));
  lines.push(out.copper(`  ${mode} ${DOT} ${permission.text}`));
  if (mode === "Build" && !permission.auto) lines.push(...wrapRailText("Build actions require your approval", Math.max(12, width - 2)).map((row) => out.gray(`  ${row}`)));

  return lines;
}

export function railWidth(columns: number): number {
  return Math.max(30, Math.min(42, Math.floor(columns * 0.25)));
}

export function showsLiveWorkRail(columns: number, hasMission: boolean): boolean {
  return hasMission && columns >= 112;
}
