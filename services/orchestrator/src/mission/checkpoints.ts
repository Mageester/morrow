import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

/**
 * Mission checkpoints and safe rollback.
 *
 * A checkpoint records the exact content of a specific set of files so the
 * mission can return THOSE files to a known state. Rollback only ever rewrites
 * files that were captured — unrelated pre-existing work is never touched, and
 * it is never a blanket `git reset --hard` of the working tree.
 *
 * Content is stored in a content-addressed backup dir (`<hash>.bak`), and a
 * per-checkpoint manifest (`<checkpointId>.json`) maps workspace-relative paths
 * to the captured hash ("" = file did not exist at capture time).
 */

export interface CheckpointSnapshot {
  /** workspace-relative path -> content hash ("" when the file did not exist). */
  files: Record<string, string>;
  /** git HEAD sha at capture time, for reference/diffing (null when not a repo). */
  gitRef: string | null;
}

export function isGitRepo(workspace: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspace, encoding: "utf8", windowsHide: true });
  return r.status === 0 && r.stdout.trim() === "true";
}

export function gitHeadRef(workspace: string): string | null {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Files git considers modified or untracked (bounded), workspace-relative. */
export function candidateFiles(workspace: string, limit = 500): string[] {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspace, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout.split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((f) => f.replace(/^"|"$/g, ""))
    // A rename line is "old -> new"; keep the new path.
    .map((f) => (f.includes(" -> ") ? f.split(" -> ")[1]! : f))
    .slice(0, limit);
}

function hashContent(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function safeJoin(workspace: string, rel: string): string | null {
  const abs = resolve(workspace, rel);
  const rp = relative(workspace, abs);
  if (rp.startsWith("..") || isAbsolute(rp)) return null;
  return abs;
}

/**
 * Capture a checkpoint. `explicitFiles` (workspace-relative) are always
 * captured; when omitted, the current git-modified/untracked set is captured so
 * a checkpoint taken before a risky change can restore everything about to move.
 */
export function captureCheckpoint(
  workspace: string,
  backupDir: string,
  checkpointId: string,
  explicitFiles?: string[],
): CheckpointSnapshot {
  mkdirSync(backupDir, { recursive: true });
  // When an explicit set is given, capture ONLY those files so rollback can
  // never touch unrelated work. Otherwise fall back to the current git-modified
  // /untracked set (what a "before risky change" checkpoint should protect).
  const targets = explicitFiles && explicitFiles.length > 0
    ? new Set<string>(explicitFiles)
    : new Set<string>(candidateFiles(workspace));
  const files: Record<string, string> = {};
  for (const rel of targets) {
    const abs = safeJoin(workspace, rel);
    if (!abs) continue;
    if (existsSync(abs)) {
      const buf = readFileSync(abs);
      const hash = hashContent(buf);
      const blob = join(backupDir, `${hash}.bak`);
      if (!existsSync(blob)) writeFileSync(blob, buf);
      files[rel] = hash;
    } else {
      files[rel] = "";
    }
  }
  const snapshot: CheckpointSnapshot = { files, gitRef: isGitRepo(workspace) ? gitHeadRef(workspace) : null };
  writeFileSync(join(backupDir, `${checkpointId}.json`), JSON.stringify(snapshot));
  return snapshot;
}

export function loadSnapshot(backupDir: string, checkpointId: string): CheckpointSnapshot | null {
  const path = join(backupDir, `${checkpointId}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as CheckpointSnapshot; } catch { return null; }
}

export interface RollbackResult {
  restored: string[];
  removed: string[];
  missing: string[];
  ok: boolean;
}

/**
 * Restore only the files captured in the checkpoint. Files whose captured hash
 * is "" (absent at capture) are deleted if they exist now. Any file outside the
 * captured set is left exactly as-is. Fails safely (ok=false) if a needed blob
 * is missing, without partially corrupting state beyond what it could restore.
 */
export function rollbackToCheckpoint(
  workspace: string,
  backupDir: string,
  checkpointId: string,
): RollbackResult {
  const snap = loadSnapshot(backupDir, checkpointId);
  const result: RollbackResult = { restored: [], removed: [], missing: [], ok: true };
  if (!snap) return { ...result, ok: false };
  // Pre-flight: ensure every needed blob exists before mutating anything.
  for (const [rel, hash] of Object.entries(snap.files)) {
    if (hash && !existsSync(join(backupDir, `${hash}.bak`))) result.missing.push(rel);
  }
  if (result.missing.length > 0) return { ...result, ok: false };

  for (const [rel, hash] of Object.entries(snap.files)) {
    const abs = safeJoin(workspace, rel);
    if (!abs) continue;
    if (hash === "") {
      if (existsSync(abs)) { rmSync(abs, { force: true }); result.removed.push(rel); }
    } else {
      const buf = readFileSync(join(backupDir, `${hash}.bak`));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, buf);
      result.restored.push(rel);
    }
  }
  return result;
}

/** A human-readable summary of what a rollback would change, without applying it. */
export function describeCheckpointDiff(workspace: string, backupDir: string, checkpointId: string): string[] {
  const snap = loadSnapshot(backupDir, checkpointId);
  if (!snap) return ["(checkpoint snapshot not found)"];
  const lines: string[] = [];
  for (const [rel, hash] of Object.entries(snap.files)) {
    const abs = safeJoin(workspace, rel);
    if (!abs) continue;
    const nowExists = existsSync(abs);
    const nowHash = nowExists ? hashContent(readFileSync(abs)) : "";
    if (nowHash === hash) continue;
    if (hash === "") lines.push(`delete   ${rel}`);
    else if (!nowExists) lines.push(`recreate ${rel}`);
    else lines.push(`restore  ${rel}`);
  }
  return lines.length ? lines : ["(no differences from checkpoint)"];
}
