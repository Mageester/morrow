import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertContainedRealPath, hashString } from "../tools/diff-applier.js";

/**
 * Named workspace checkpoints — snapshot and restore.
 *
 * A checkpoint captures the exact content (or absence) of a set of
 * workspace-relative files. Content is stored once per hash in the same
 * content-addressed backup store change-set undo uses
 * (`MORROW_HOME/backups/<hash>.bak`), so snapshots are cheap and share storage
 * with existing backups.
 *
 * Restore is deliberately reversible: before any file is touched, the caller
 * snapshots the *current* state of the same file set as an automatic
 * `auto/pre-restore-…` checkpoint, so a bad restore is one more restore away
 * from recovery. Every path passes the same containment gate as undo
 * (absolute/traversal/symlink/.git rejection).
 */

const MAX_CHECKPOINT_FILE_BYTES = 5 * 1024 * 1024;

export interface SnapshotResult {
  /** relative path → content hash ("" when the file does not exist). */
  files: Record<string, string>;
  skipped: Array<{ path: string; reason: string }>;
}

/** Capture the current content of `files` into the backup store. */
export function snapshotFiles(workspacePath: string, backupsDir: string, files: string[]): SnapshotResult {
  mkdirSync(backupsDir, { recursive: true });
  const result: SnapshotResult = { files: {}, skipped: [] };
  for (const rel of files) {
    // Containment throws for hostile paths — the caller maps that to a 4xx.
    const fullPath = assertContainedRealPath(workspacePath, rel);
    if (!existsSync(fullPath)) {
      result.files[rel] = "";
      continue;
    }
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      result.skipped.push({ path: rel, reason: "unreadable" });
      continue;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_FILE_BYTES) {
      result.skipped.push({ path: rel, reason: "exceeds 5 MB checkpoint limit" });
      continue;
    }
    const hash = hashString(content);
    const backupFile = join(backupsDir, `${hash}.bak`);
    if (!existsSync(backupFile)) writeFileSync(backupFile, content, "utf8");
    result.files[rel] = hash;
  }
  return result;
}

export interface RestoreResult {
  restoredFiles: string[];
  deletedFiles: string[];
}

/**
 * Write every file in the checkpoint back to its captured state.
 * Hash "" means "did not exist at snapshot time" → the current file is removed.
 * Throws when a needed backup blob is missing (nothing partially applied
 * before the first write: all backups are verified up front).
 */
export function restoreSnapshot(workspacePath: string, backupsDir: string, files: Record<string, string>): RestoreResult {
  // Verify everything first so a missing blob can't strand a half-restore.
  const resolved: Array<{ rel: string; fullPath: string; hash: string }> = [];
  for (const [rel, hash] of Object.entries(files)) {
    const fullPath = assertContainedRealPath(workspacePath, rel);
    if (hash !== "" && !existsSync(join(backupsDir, `${hash}.bak`))) {
      throw new Error(`Checkpoint content missing from backup store for ${rel}`);
    }
    resolved.push({ rel, fullPath, hash });
  }

  const result: RestoreResult = { restoredFiles: [], deletedFiles: [] };
  for (const { rel, fullPath, hash } of resolved) {
    if (hash === "") {
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
        result.deletedFiles.push(rel);
      }
      continue;
    }
    const content = readFileSync(join(backupsDir, `${hash}.bak`), "utf8");
    const current = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : null;
    if (current !== null && hashString(current) === hash) continue; // already at snapshot state
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    result.restoredFiles.push(rel);
  }
  return result;
}

/** Checkpoint names: human-friendly, safe in URLs/logs, no control chars. */
export function isValidCheckpointName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(name) && !name.includes("..");
}
