import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationAttempt, IntegrationStatus } from "../repositories/integrations.js";
import type { WorktreeRecord } from "../repositories/worktrees.js";
import { runGit } from "./worktrees.js";

// Merges run under an explicit identity: CI runners and fresh machines have no
// global user.name/user.email, and git refuses to merge without one (exit 128,
// "Committer identity unknown") — even for --no-commit dry runs.
const MERGE_IDENT = ["-c", "user.name=Morrow", "-c", "user.email=morrow@localhost"];

export class IntegrationError extends Error {
  constructor(message: string, readonly code: "not_found" | "conflict" | "git_failed" | "validation" = "git_failed") {
    super(message);
    this.name = "IntegrationError";
  }
}

export interface IntegrationsRepo {
  create(input: {
    id: string;
    projectId: string;
    taskId?: string | null;
    agentId?: string | null;
    worktreeId: string;
    sourceBranch: string;
    targetBranch: string;
    sourceCommit: string;
    targetCommit: string;
    status: IntegrationStatus;
    conflictedFiles?: string[];
    errorDetail?: string | null;
  }): IntegrationAttempt;
  get(id: string): IntegrationAttempt | undefined;
  listByProject(projectId: string, status?: IntegrationStatus): IntegrationAttempt[];
  update(id: string, patch: {
    status: IntegrationStatus;
    conflictedFiles?: string[];
    errorDetail?: string | null;
    appliedCommit?: string | null;
    appliedAt?: string | null;
    cancelledAt?: string | null;
  }): IntegrationAttempt;
}

export interface WorktreesRepoForIntegration {
  get(id: string): WorktreeRecord | undefined;
}

function git(cwd: string, args: string[], context: string) {
  const r = runGit(cwd, args);
  if (r.exitCode !== 0) throw new IntegrationError(`${context}: ${r.stderr.trim() || r.stdout.trim() || `git exited ${r.exitCode}`}`);
  return r.stdout.trim();
}

function currentBranch(cwd: string): string {
  const branch = git(cwd, ["branch", "--show-current"], "Cannot determine current branch");
  return branch || "HEAD";
}

function dirtyFiles(cwd: string): string[] {
  const r = runGit(cwd, ["status", "--porcelain=v1"]);
  if (r.exitCode !== 0) throw new IntegrationError(`Cannot read repository status: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function conflictFiles(cwd: string): string[] {
  const r = runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  if (r.exitCode !== 0) return [];
  return r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

export class IntegrationManager {
  constructor(
    private readonly attempts: IntegrationsRepo,
    private readonly worktrees: WorktreesRepoForIntegration,
    private readonly workspacePathByProject: (projectId: string) => string | undefined
  ) {}

  check(worktreeId: string, options: { targetBranch?: string } = {}): IntegrationAttempt {
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree) throw new IntegrationError("Worktree not found", "not_found");
    if (worktree.status !== "active" || !existsSync(worktree.path)) {
      throw new IntegrationError(`Worktree is not active (${worktree.status})`, "conflict");
    }
    const workspacePath = this.workspacePathByProject(worktree.projectId);
    if (!workspacePath) throw new IntegrationError("Project workspace not found", "not_found");

    const targetBranch = options.targetBranch ?? currentBranch(workspacePath);
    const sourceCommit = git(worktree.path, ["rev-parse", "HEAD"], "Cannot resolve source commit");
    const targetCommit = git(workspacePath, ["rev-parse", targetBranch], "Cannot resolve target branch");
    const base = {
      id: randomUUID(),
      projectId: worktree.projectId,
      taskId: worktree.taskId,
      agentId: worktree.agentId,
      worktreeId: worktree.id,
      sourceBranch: worktree.branch,
      targetBranch,
      sourceCommit,
      targetCommit,
    };

    const dirty = dirtyFiles(workspacePath);
    if (dirty.length > 0) {
      return this.attempts.create({
        ...base,
        status: "failed",
        errorDetail: `Target repository has uncommitted changes (${dirty.length} path${dirty.length === 1 ? "" : "s"}). Commit, stash, or discard them before integrating.`,
      });
    }

    const sandbox = mkdtempSync(join(tmpdir(), "morrow-integrate-"));
    try {
      const clone = runGit(workspacePath, ["clone", "--shared", "--no-checkout", workspacePath, sandbox], 60_000);
      if (clone.exitCode !== 0) throw new IntegrationError(`Failed to create integration sandbox: ${clone.stderr.trim() || clone.stdout.trim()}`);
      git(sandbox, ["checkout", "-B", "morrow-integration-target", targetCommit], "Failed to checkout target in sandbox");
      const merge = runGit(sandbox, [...MERGE_IDENT, "merge", "--no-commit", "--no-ff", sourceCommit], 60_000);
      if (merge.exitCode === 0) {
        return this.attempts.create({ ...base, status: "clean" });
      }
      const conflicts = conflictFiles(sandbox);
      return this.attempts.create({
        ...base,
        status: conflicts.length > 0 ? "conflicted" : "failed",
        conflictedFiles: conflicts,
        errorDetail: conflicts.length > 0 ? null : (merge.stderr.trim() || merge.stdout.trim() || "Dry-run merge failed"),
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  apply(id: string): IntegrationAttempt {
    const attempt = this.attempts.get(id);
    if (!attempt) throw new IntegrationError("Integration attempt not found", "not_found");
    if (attempt.status !== "clean") throw new IntegrationError(`Integration attempt is ${attempt.status}; run a fresh clean check before applying`, "conflict");
    const workspacePath = this.workspacePathByProject(attempt.projectId);
    if (!workspacePath) throw new IntegrationError("Project workspace not found", "not_found");
    if (dirtyFiles(workspacePath).length > 0) {
      return this.attempts.update(id, { status: "failed", errorDetail: "Target repository has uncommitted changes; apply refused." });
    }
    const branch = currentBranch(workspacePath);
    if (branch !== attempt.targetBranch) {
      return this.attempts.update(id, { status: "failed", errorDetail: `Target branch changed from ${attempt.targetBranch} to ${branch}; apply refused.` });
    }
    const head = git(workspacePath, ["rev-parse", "HEAD"], "Cannot resolve target HEAD");
    if (head !== attempt.targetCommit) {
      return this.attempts.update(id, { status: "failed", errorDetail: "Target branch moved since the integration check; run a fresh check." });
    }

    const merge = runGit(workspacePath, [...MERGE_IDENT, "merge", "--no-ff", attempt.sourceCommit, "-m", `morrow: integrate ${attempt.sourceBranch}`], 60_000);
    if (merge.exitCode !== 0) {
      const conflicts = conflictFiles(workspacePath);
      runGit(workspacePath, ["merge", "--abort"]);
      return this.attempts.update(id, {
        status: conflicts.length > 0 ? "conflicted" : "failed",
        conflictedFiles: conflicts,
        errorDetail: conflicts.length > 0 ? null : (merge.stderr.trim() || merge.stdout.trim() || "Apply failed"),
      });
    }
    const appliedCommit = git(workspacePath, ["rev-parse", "HEAD"], "Cannot resolve applied commit");
    return this.attempts.update(id, { status: "applied", appliedCommit, appliedAt: new Date().toISOString() });
  }

  cancel(id: string): IntegrationAttempt {
    const attempt = this.attempts.get(id);
    if (!attempt) throw new IntegrationError("Integration attempt not found", "not_found");
    if (attempt.status === "applied") throw new IntegrationError("Applied integrations cannot be cancelled", "conflict");
    if (attempt.status === "cancelled") return attempt;
    return this.attempts.update(id, { status: "cancelled", cancelledAt: new Date().toISOString() });
  }
}
