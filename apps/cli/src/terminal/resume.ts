/**
 * Pure resume-freshness digest.
 *
 * Resuming a session should never continue "blindly": the repository may have
 * moved (external commits, new uncommitted work) and the Cortex knowledge may be
 * stale relative to the current tree. This composes an honest digest of both so
 * the user sees the ground truth before their next instruction acts on it.
 *
 * No I/O — the git and staleness facts are passed in — so it is snapshot-testable.
 */
import type { Output } from "../cli/output.js";
import { glyphs } from "./view.js";

export interface ResumeGitState {
  branch: string | null;
  dirty: number;
  ahead: number;
  behind: number;
}

export interface ResumeStaleness {
  changedScopes: string[];
  itemsMarked: number;
  architectureStale: boolean;
}

export interface ResumeDigest {
  priorMessages: number;
  git?: ResumeGitState | null;
  staleness?: ResumeStaleness | null;
}

/** Whether the digest found anything worth flagging before continuing. */
export function resumeHasWarnings(d: ResumeDigest): boolean {
  const dirty = (d.git?.dirty ?? 0) > 0 || (d.git?.behind ?? 0) > 0;
  const stale = Boolean(d.staleness && (d.staleness.changedScopes.length > 0 || d.staleness.architectureStale));
  return dirty || stale;
}

/** One-line notice for the resume banner (kept short for the notice area). */
export function resumeNoticeText(d: ResumeDigest): string {
  const bits: string[] = [];
  if (d.git && d.git.dirty > 0) bits.push(`${d.git.dirty} uncommitted change${d.git.dirty === 1 ? "" : "s"}`);
  if (d.git && d.git.behind > 0) bits.push(`${d.git.behind} behind`);
  if (d.staleness && (d.staleness.changedScopes.length > 0 || d.staleness.architectureStale)) bits.push("Cortex may be stale");
  if (bits.length === 0) return "Resumed — repository and Cortex look current. Run /resume for details.";
  return `Resumed with ${bits.join(" · ")}. Run /resume before relying on prior context.`;
}

export function resumeDigestLines(d: ResumeDigest, out: Output, unicode: boolean): string[] {
  const g = glyphs(unicode);
  const lines: string[] = [];
  lines.push(out.bold("Resuming this session"));
  if (d.priorMessages > 0) lines.push("  " + out.gray(`${d.priorMessages} earlier message${d.priorMessages === 1 ? "" : "s"} restored.`));
  lines.push("");

  // Repository posture.
  lines.push(out.bold("Repository"));
  if (!d.git || d.git.branch === null) {
    lines.push("  " + out.gray("not a Git repository, or no branch — change tracking unavailable."));
  } else {
    const dirty = d.git.dirty === 0 ? out.green("clean") : out.yellow(`${d.git.dirty} uncommitted change${d.git.dirty === 1 ? "" : "s"}`);
    lines.push(`  ${out.gray("branch")} ${out.cyan(d.git.branch)}  ${out.gray(g.dot)}  ${dirty}`);
    if (d.git.ahead > 0 || d.git.behind > 0) {
      lines.push(`  ${out.gray(`${d.git.ahead} ahead · ${d.git.behind} behind the upstream`)}`);
    }
    if (d.git.behind > 0) {
      lines.push("  " + out.yellow(`${g.warn} Upstream moved — the working tree may differ from when this session paused.`));
    }
  }
  lines.push("");

  // Cortex freshness.
  lines.push(out.bold("Cortex knowledge"));
  const s = d.staleness;
  if (!s) {
    lines.push("  " + out.gray("no Cortex map for this project yet — run /cortex to build one."));
  } else if (s.changedScopes.length === 0 && !s.architectureStale) {
    lines.push("  " + out.green("current — no scopes changed since the last mapping."));
  } else {
    const parts: string[] = [];
    if (s.changedScopes.length > 0) parts.push(`${s.changedScopes.length} scope${s.changedScopes.length === 1 ? "" : "s"} changed`);
    if (s.itemsMarked > 0) parts.push(`${s.itemsMarked} item${s.itemsMarked === 1 ? "" : "s"} marked stale`);
    if (s.architectureStale) parts.push("architecture flagged");
    lines.push("  " + out.yellow(`${g.warn} ${parts.join(" · ")}.`));
    for (const scope of s.changedScopes.slice(0, 5)) lines.push("    " + out.gray(scope));
    if (s.changedScopes.length > 5) lines.push("    " + out.gray(`+${s.changedScopes.length - 5} more`));
    lines.push("  " + out.gray("Refresh with ") + out.cyan("/cortex") + out.gray(" (or ") + out.cyan("morrow cortex refresh") + out.gray(") before relying on it."));
  }
  return lines;
}
