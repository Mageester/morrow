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
