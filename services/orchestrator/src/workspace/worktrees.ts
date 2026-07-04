import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorktreeRecord, WorktreeStatus } from "../repositories/worktrees.js";

/**
 * Git worktree isolation for agents and tasks.
 *
 * Every Morrow-managed worktree lives under `<worktreesRoot>/<projectId>/` on a
 * deterministic `morrow/<name>` branch. Safety rules:
 * - Branch and directory collisions are detected up front (409, never clobber).
 * - Removal REFUSES a dirty worktree unless `preserve` is requested, in which
 *   case the uncommitted work is committed to the worktree branch first. The
 *   branch itself is never deleted by removal, so committed work always has a
 *   recovery path (`git checkout morrow/<name>`).
 * - Reconciliation marks rows whose directory vanished as `abandoned` (the
 *   branch may still carry the work) and prunes git's own stale bookkeeping.
 *
 * Git operations run synchronously with bounded output; this module performs
 * only structured, no-shell invocations (`git -C <dir> …`).
 */

export class WorktreeError extends Error {
  constructor(message: string, readonly code: "not_a_repo" | "conflict" | "dirty" | "git_failed" | "not_found" | "invalid_name" = "git_failed") {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[], timeoutMs = 30_000): GitResult {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) throw new WorktreeError(`Unable to run git: ${r.error.message}`);
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ensureGit(cwd: string, args: string[], context: string): GitResult {
  const r = runGit(cwd, args);
  if (r.exitCode !== 0) {
    throw new WorktreeError(`${context}: ${r.stderr.trim() || r.stdout.trim() || `git exited ${r.exitCode}`}`);
  }
  return r;
}

export function isGitRepo(path: string): boolean {
  try {
    const r = runGit(path, ["rev-parse", "--is-inside-work-tree"]);
    return r.exitCode === 0 && r.stdout.trim() === "true";
  } catch {
    return false;
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export interface WorktreesRepo {
  create(input: { id: string; projectId: string; taskId?: string | null; agentId?: string | null; branch: string; path: string; baseRef: string }): WorktreeRecord;
  get(id: string): WorktreeRecord | undefined;
  findByBranch(projectId: string, branch: string): WorktreeRecord | undefined;
  listByProject(projectId: string, status?: WorktreeStatus): WorktreeRecord[];
  listActive(): WorktreeRecord[];
  setStatus(id: string, status: Exclude<WorktreeStatus, "active">, detail: string | null): boolean;
}

export interface WorktreeStatusReport {
  record: WorktreeRecord;
  exists: boolean;
  dirty: boolean;
  dirtyFiles: string[];
  /** Commits on the worktree branch that the base ref does not have. */
  aheadCommits: Array<{ hash: string; subject: string }>;
}

export class WorktreeManager {
  constructor(
    private readonly repo: WorktreesRepo,
    private readonly worktreesRoot: string
  ) {}

  /** Create an isolated worktree on a fresh deterministic morrow/<name> branch. */
  create(options: {
    projectId: string;
    workspacePath: string;
    name?: string;
    taskId?: string | null;
    agentId?: string | null;
    baseRef?: string;
  }): WorktreeRecord {
    if (!isGitRepo(options.workspacePath)) {
      throw new WorktreeError("The project workspace is not a git repository", "not_a_repo");
    }
    const rawName = options.name ?? (options.taskId ? `task-${options.taskId.slice(0, 8)}` : `wt-${randomUUID().slice(0, 8)}`);
    if (!NAME_RE.test(rawName)) {
      throw new WorktreeError("Worktree names may use letters, digits, dot, dash, and underscore (max 81 chars)", "invalid_name");
    }
    const branch = `morrow/${rawName}`;

    if (this.repo.findByBranch(options.projectId, branch)) {
      throw new WorktreeError(`A worktree for branch ${branch} already exists in this project`, "conflict");
    }
    // Detect a pre-existing branch (from any source) — never reuse silently.
    const branchProbe = runGit(options.workspacePath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (branchProbe.exitCode === 0) {
      throw new WorktreeError(`Branch ${branch} already exists in the repository`, "conflict");
    }

    const dir = resolve(join(this.worktreesRoot, options.projectId, rawName));
    if (existsSync(dir)) {
      throw new WorktreeError(`Worktree directory already exists: ${dir}`, "conflict");
    }
    mkdirSync(join(this.worktreesRoot, options.projectId), { recursive: true });

    const baseRef = options.baseRef ?? "HEAD";
    // Record the concrete commit the worktree started from so status/diff
    // comparisons stay stable even when the source branch moves on.
    const baseCommit = ensureGit(options.workspacePath, ["rev-parse", baseRef], "Cannot resolve base ref").stdout.trim();
    ensureGit(options.workspacePath, ["worktree", "add", "-b", branch, dir, baseCommit], "Failed to create worktree");

    return this.repo.create({
      id: randomUUID(),
      projectId: options.projectId,
      taskId: options.taskId ?? null,
      agentId: options.agentId ?? null,
      branch,
      path: dir,
      baseRef: baseCommit,
    });
  }

  /** Live status: existence, dirtiness, and commits ahead of the base. */
  status(id: string): WorktreeStatusReport {
    const record = this.repo.get(id);
    if (!record) throw new WorktreeError("Worktree not found", "not_found");
    if (!existsSync(record.path)) {
      return { record, exists: false, dirty: false, dirtyFiles: [], aheadCommits: [] };
    }
    const st = ensureGit(record.path, ["status", "--porcelain=v1"], "Failed to read worktree status");
    const dirtyFiles = st.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
    const log = runGit(record.path, ["log", "--format=%H%x09%s", `${record.baseRef}..HEAD`]);
    const aheadCommits = log.exitCode === 0
      ? log.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          const [hash, ...rest] = line.split("\t");
          return { hash: hash!, subject: rest.join("\t") };
        })
      : [];
    return { record, exists: true, dirty: dirtyFiles.length > 0, dirtyFiles, aheadCommits };
  }

  /** Bounded diff of the worktree branch against its recorded base. */
  diff(id: string, maxBytes = 256 * 1024): { diff: string; truncated: boolean } {
    const record = this.repo.get(id);
    if (!record) throw new WorktreeError("Worktree not found", "not_found");
    if (!existsSync(record.path)) throw new WorktreeError("Worktree directory is missing", "not_found");
    const r = ensureGit(record.path, ["diff", record.baseRef, "HEAD"], "Failed to diff worktree");
    const truncated = Buffer.byteLength(r.stdout, "utf8") > maxBytes;
    return { diff: truncated ? Buffer.from(r.stdout, "utf8").subarray(0, maxBytes).toString("utf8") : r.stdout, truncated };
  }

  /**
   * Remove a worktree. A dirty tree is refused unless `preserve` is set, in
   * which case the uncommitted work is committed onto the worktree branch
   * first (so nothing is lost). The branch is always left in place.
   */
  remove(id: string, options: { preserve?: boolean } = {}): { record: WorktreeRecord; preservedCommit: string | null } {
    const record = this.repo.get(id);
    if (!record) throw new WorktreeError("Worktree not found", "not_found");
    if (record.status !== "active") throw new WorktreeError(`Worktree is already ${record.status}`, "conflict");

    let preservedCommit: string | null = null;
    if (existsSync(record.path)) {
      const st = ensureGit(record.path, ["status", "--porcelain=v1"], "Failed to read worktree status");
      const dirty = st.stdout.split(/\r?\n/).some((line) => line.trim().length > 0);
      if (dirty) {
        if (!options.preserve) {
          throw new WorktreeError(
            "Worktree has uncommitted changes. Pass preserve=true to commit them onto the worktree branch before removal, or commit/discard them manually.",
            "dirty"
          );
        }
        ensureGit(record.path, ["add", "-A"], "Failed to stage work for preservation");
        ensureGit(
          record.path,
          ["-c", "user.name=Morrow", "-c", "user.email=morrow@localhost", "commit", "-m", "morrow: preserve uncommitted work before worktree removal"],
          "Failed to preserve uncommitted work"
        );
        preservedCommit = ensureGit(record.path, ["rev-parse", "HEAD"], "Failed to read preserved commit").stdout.trim();
      }
      // Locate the main repository to run `worktree remove` from.
      const commonDir = ensureGit(record.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "Failed to locate main repository").stdout.trim();
      const mainRepo = resolve(commonDir, "..");
      ensureGit(mainRepo, ["worktree", "remove", "--force", record.path], "Failed to remove worktree");
    }

    const detail = preservedCommit
      ? `uncommitted work preserved as ${preservedCommit.slice(0, 12)} on ${record.branch}`
      : `branch ${record.branch} retained`;
    this.repo.setStatus(record.id, "removed", detail);
    return { record: this.repo.get(record.id)!, preservedCommit };
  }

  /** Mark active rows whose directory vanished as abandoned; prune git bookkeeping. */
  reconcile(workspacePathByProject: (projectId: string) => string | undefined): { abandoned: number } {
    let abandoned = 0;
    for (const record of this.repo.listActive()) {
      if (existsSync(record.path)) continue;
      this.repo.setStatus(record.id, "abandoned", `directory missing; branch ${record.branch} may still hold the work`);
      abandoned++;
      const workspace = workspacePathByProject(record.projectId);
      if (workspace && isGitRepo(workspace)) {
        runGit(workspace, ["worktree", "prune"]);
      }
    }
    return { abandoned };
  }
}
