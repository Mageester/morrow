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
    if (branchRes.status !== 0) return { branch: null, dirty: 0 };
    const branch = (branchRes.stdout || "").trim() || null;
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
