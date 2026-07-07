import { spawnSync } from "node:child_process";

/**
 * Read-only Git summary for the session header. This is display only — it never
 * mutates the repository and is unrelated to agent command execution (which
 * stays in the orchestrator). Bounded and no-shell.
 */
export interface GitSummary {
  branch: string | null;
  dirty: number;
}

export function gitSummary(cwd: string): GitSummary {
  const run = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", shell: false, timeout: 2000, windowsHide: true });
  try {
    const branchRes = run(["rev-parse", "--abbrev-ref", "HEAD"]);
    let branch = branchRes.status === 0 ? (branchRes.stdout || "").trim() || null : null;
    // Brand-new repositories have an unborn HEAD; rev-parse can fail even though
    // `git status` and the symbolic branch are available. Keep the header honest
    // for `morrow init` by falling back before giving up.
    if (!branch || branch === "HEAD") {
      const symbolic = run(["symbolic-ref", "--short", "HEAD"]);
      branch = symbolic.status === 0 ? (symbolic.stdout || "").trim() || branch : branch;
    }
    if (!branch || branch === "HEAD") {
      const shown = run(["branch", "--show-current"]);
      branch = shown.status === 0 ? (shown.stdout || "").trim() || null : null;
    }
    const statusRes = run(["status", "--porcelain"]);
    const dirty = statusRes.status === 0 ? (statusRes.stdout || "").split(/\r?\n/).filter((l) => l.trim().length > 0).length : 0;
    return { branch, dirty };
  } catch {
    return { branch: null, dirty: 0 };
  }
}

export function gitSummaryText(summary: GitSummary): string {
  if (!summary.branch) return "—";
  return summary.dirty === 0 ? `${summary.branch} · clean` : `${summary.branch} · ${summary.dirty} changed`;
}

/** A richer read-only status: branch, ahead/behind, and categorized file lists. */
export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
}

/**
 * Read a categorized, read-only Git status via porcelain v2. Never mutates the
 * repo; bounded and no-shell. Returns `isRepo: false` outside a work tree.
 */
export function gitStatus(cwd: string): GitStatus {
  const empty: GitStatus = { isRepo: false, branch: null, ahead: 0, behind: 0, staged: [], modified: [], untracked: [] };
  const run = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", shell: false, timeout: 2500, windowsHide: true });
  try {
    const res = run(["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
    if (res.status !== 0) return empty;
    const status: GitStatus = { ...empty, isRepo: true, staged: [], modified: [], untracked: [] };
    for (const raw of (res.stdout || "").split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (line.startsWith("# branch.head ")) {
        const b = line.slice("# branch.head ".length).trim();
        status.branch = b === "(detached)" ? null : b;
      } else if (line.startsWith("# branch.ab ")) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) { status.ahead = Number(m[1]); status.behind = Number(m[2]); }
      } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
        // Ordinary/renamed entry: "<1|2> <XY> <sub> <mH> <mI> <mW> <hH> <hI> [<score>] <path>".
        // XY are the staged/worktree change flags; a "." means unchanged there.
        const parts = line.split(" ");
        const xy = parts[1] ?? "..";
        const pathStart = line.startsWith("2 ") ? 9 : 8; // renamed entries carry an extra score field
        // Renamed paths are "<new>\t<old>"; keep the new path.
        const file = parts.slice(pathStart).join(" ").split("\t")[0] ?? "";
        if (xy[0] && xy[0] !== ".") status.staged.push(file);
        if (xy[1] && xy[1] !== ".") status.modified.push(file);
      } else if (line.startsWith("? ")) {
        status.untracked.push(line.slice(2));
      }
    }
    return status;
  } catch {
    return empty;
  }
}
