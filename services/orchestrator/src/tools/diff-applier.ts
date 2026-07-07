import { basename, dirname, join, resolve, relative, posix, win32 } from "node:path";
import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

export interface PatchFile {
  oldPath: string;
  newPath: string;
  chunks: PatchChunk[];
}

export interface PatchChunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export type PatchConflictCategory =
  | "context_mismatch"
  | "ambiguous_context"
  | "malformed_patch";

export class PatchApplicationError extends Error {
  readonly category: PatchConflictCategory;
  readonly hunk: PatchChunk;
  readonly expected: string;
  readonly actual: string;
  readonly line: number;

  constructor(message: string, details: { category: PatchConflictCategory; hunk: PatchChunk; expected: string; actual: string; line: number }) {
    super(message);
    this.name = "PatchApplicationError";
    this.category = details.category;
    this.hunk = details.hunk;
    this.expected = details.expected;
    this.actual = details.actual;
    this.line = details.line;
  }
}

export function hashString(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Build a unified-diff that creates a brand-new file from raw content. Models
 * are unreliable at hand-authoring `@@ -0,0 +1,N @@` creation hunks (the line
 * count must match exactly), so the `create_file` tool takes plain
 * `path` + `content` and synthesizes the diff here, then feeds it through the
 * same validate → approve → apply → change-set pipeline as an edit patch. That
 * keeps a single code path (backups, undo, `/diff`, `/changes`) instead of a
 * parallel write mechanism.
 *
 * Line endings are normalized to LF to match the rest of the patch pipeline,
 * which reads and writes with `\n`.
 */
export function buildCreationDiff(relPath: string, content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const target = relPath.replace(/\\/g, "/");
  if (normalized.length === 0) {
    // Empty file: an empty hunk creates a zero-length file.
    return `--- /dev/null\n+++ b/${target}\n@@ -0,0 +0,0 @@\n`;
  }
  const lines = normalized.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return `--- /dev/null\n+++ b/${target}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

/**
 * Model and user supplied paths can use either path dialect regardless of the
 * host Morrow is running on. `path.isAbsolute` only understands the host
 * dialect, so it would accept `C:\\Windows\\...` when the service runs on
 * Linux/WSL. Reject both forms before any containment calculation.
 */
export function isAnyAbsolutePath(candidate: string): boolean {
  return posix.isAbsolute(candidate) || win32.isAbsolute(candidate);
}

export function parseUnifiedDiff(diffStr: string): PatchFile[] {
  const lines = diffStr.split(/\r?\n/);
  const files: PatchFile[] = [];
  let currentFile: PatchFile | null = null;
  let currentChunk: PatchChunk | null = null;

  // Rejected keywords for security & constraint compliance
  const forbiddenKeywords = [
    "old mode ",
    "new mode ",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
    "similarity index ",
    "dissimilarity index ",
    "GIT binary patch",
    "Binary files ",
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    for (const kw of forbiddenKeywords) {
      if (line.includes(kw)) {
        throw new Error(`Unsupported diff feature: found "${kw}"`);
      }
    }

    if (line.startsWith("--- ")) {
      const oldPathRaw = line.slice(4).trim();
      let oldPath = oldPathRaw;
      if (oldPath.startsWith("a/")) oldPath = oldPath.slice(2);
      currentFile = {
        oldPath,
        newPath: "",
        chunks: [],
      };
      files.push(currentFile);
      currentChunk = null;
    } else if (line.startsWith("+++ ") && currentFile) {
      const newPathRaw = line.slice(4).trim();
      let newPath = newPathRaw;
      if (newPath.startsWith("b/")) newPath = newPath.slice(2);
      currentFile.newPath = newPath;
    } else if (line.startsWith("@@ ") && currentFile) {
      const match = line.match(/^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
      if (!match) {
        throw new Error(`Malformed hunk header: ${line}`);
      }
      const m1 = match[1];
      const m2 = match[2];
      const m3 = match[3];
      const m4 = match[4];
      if (m1 === undefined || m3 === undefined) {
        throw new Error(`Malformed hunk header values: ${line}`);
      }
      const oldStart = parseInt(m1, 10);
      const oldLines = m2 !== undefined ? parseInt(m2, 10) : 1;
      const newStart = parseInt(m3, 10);
      const newLines = m4 !== undefined ? parseInt(m4, 10) : 1;

      currentChunk = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      currentFile.chunks.push(currentChunk);
    } else if (currentChunk) {
      if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) {
        currentChunk.lines.push(line);
      } else if (line.startsWith("\\ No newline at end of file")) {
        // Ignore this git diff marker for newline formatting
      } else if (line.trim() === "" && i === lines.length - 1) {
        // Allowed EOF empty line
      } else {
        // Stop chunk accumulation on other headers
        currentChunk = null;
      }
    }
  }

  // Validate hunk line counts
  for (const file of files) {
    for (const chunk of file.chunks) {
      let expectedOld = 0;
      let expectedNew = 0;
      for (const chunkLine of chunk.lines) {
        const prefix = chunkLine.charAt(0);
        if (prefix === " " || prefix === "-") expectedOld++;
        if (prefix === " " || prefix === "+") expectedNew++;
      }
      if (expectedOld !== chunk.oldLines || expectedNew !== chunk.newLines) {
        throw new Error(
          `Hunk line count mismatch for ${file.newPath}: @@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@. Expected old=${chunk.oldLines}, actual=${expectedOld}. Expected new=${chunk.newLines}, actual=${expectedNew}.`
        );
      }
    }
  }

  return files;
}

export function validatePatchPaths(
  workspacePath: string,
  files: PatchFile[],
  deniedPatterns: string[] = []
): void {
  const check = (relPath: string) => {
    if (relPath === "/dev/null") return;
    if (isAnyAbsolutePath(relPath)) {
      throw new Error(`Absolute paths are rejected: ${relPath}`);
    }
    const normalized = relPath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    if (parts.includes("..") || parts.includes(".git")) {
      throw new Error(`Parent traversal and .git paths are rejected: ${relPath}`);
    }
    const resolved = resolve(workspacePath, relPath);
    const rel = relative(workspacePath, resolved);
    if (rel.startsWith("..") || isAnyAbsolutePath(rel)) {
      throw new Error(`Path is outside workspace containment: ${relPath}`);
    }

    // Denied patterns
    const name = basename(relPath).toLowerCase();
    for (const pat of deniedPatterns) {
      const regex = new RegExp("^" + pat.replace(/\*/g, ".*") + "$", "i");
      if (regex.test(name)) {
        throw new Error(`Access to denied path pattern is rejected: ${relPath}`);
      }
    }
  };

  for (const file of files) {
    // File creation (`--- /dev/null`) is supported: the apply path treats a
    // null old side as an empty original and writes the new file (creating
    // parent directories), and the change-set undo path removes a created file
    // to restore the prior absent state. Only the new side is validated for
    // containment in that case. Deletion (`+++ /dev/null`) remains unsupported —
    // reject it rather than half-applying.
    if (file.newPath === "/dev/null") {
      throw new Error("File deletion is not supported yet");
    }
    if (file.oldPath !== "/dev/null") check(file.oldPath);
    check(file.newPath);
  }
}

/**
 * Resolve a workspace-relative path to an absolute path while enforcing
 * containment against symlink escape. Unlike {@link validatePatchPaths} (which
 * is a pure-string parser guard), this performs real filesystem resolution and
 * MUST be called immediately before any read/write/exec against a resolved path.
 *
 * It rejects absolute paths, `..` traversal, `.git`, and — critically — any
 * path whose real location (after resolving symlinks on the path itself or any
 * existing ancestor directory) falls outside the workspace's real root. Targets
 * that do not yet exist are allowed as long as their nearest existing ancestor
 * is contained, so legitimate new-file creation still works.
 *
 * @returns the resolved absolute path (against the real workspace root).
 */
export function assertContainedRealPath(workspaceRoot: string, relPath: string): string {
  if (isAnyAbsolutePath(relPath)) {
    throw new Error(`Absolute paths are rejected: ${relPath}`);
  }
  const normalized = relPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("..") || parts.includes(".git")) {
    throw new Error(`Parent traversal and .git paths are rejected: ${relPath}`);
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch {
    throw new Error(`Workspace root is inaccessible: ${workspaceRoot}`);
  }

  const candidate = resolve(realRoot, normalized);

  // Walk up to the nearest existing ancestor and resolve symlinks there. This
  // catches both a symlinked leaf and a symlinked intermediate directory.
  let probe = candidate;
  while (!existsSync(probe) && dirname(probe) !== probe) {
    probe = dirname(probe);
  }
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    throw new Error(`Path is inaccessible: ${relPath}`);
  }

  const rel = relative(realRoot, realProbe);
  if (rel !== "" && (rel.startsWith("..") || isAnyAbsolutePath(rel))) {
    throw new Error(`Path escapes the workspace via symlink or traversal: ${relPath}`);
  }
  return candidate;
}

export function applyUnifiedPatch(
  fileContent: string | null, // null if file is being created
  chunks: PatchChunk[]
): string {
  const newline = fileContent !== null && fileContent.includes("\r\n") ? "\r\n" : "\n";
  let fileLines = fileContent !== null ? fileContent.split(/\r?\n/) : [];

  // Sort chunks by oldStart descending to apply modifications from bottom to top
  const sortedChunks = [...chunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const chunk of sortedChunks) {
    const application = findChunkApplication(fileLines, chunk);
    const startIdx = application.startIdx;
    const newLinesToInsert: string[] = [];

    // Build the insertion segment
    for (const chunkLine of chunk.lines) {
      const prefix = chunkLine.charAt(0);
      const lineText = chunkLine.slice(1);
      if (application.replaceDeletedOnly) {
        if (prefix === "+") newLinesToInsert.push(lineText);
      } else if (prefix === " " || prefix === "+") {
        newLinesToInsert.push(lineText);
      }
    }

    fileLines.splice(startIdx, application.removeLines, ...newLinesToInsert);
  }

  return fileLines.join(newline);
}

function oldComparableLines(chunk: PatchChunk): string[] {
  return chunk.lines
    .filter((line) => line.startsWith(" ") || line.startsWith("-"))
    .map((line) => line.slice(1));
}

function deletedLines(chunk: PatchChunk): string[] {
  return chunk.lines
    .filter((line) => line.startsWith("-"))
    .map((line) => line.slice(1));
}

function matchesAt(fileLines: string[], startIdx: number, expected: string[], normalize: (line: string) => string): boolean {
  if (startIdx < 0 || startIdx + expected.length > fileLines.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (normalize(fileLines[startIdx + i]!) !== normalize(expected[i]!)) return false;
  }
  return true;
}

function findMatches(fileLines: string[], expected: string[], normalize: (line: string) => string): number[] {
  if (expected.length === 0) return [];
  const matches: number[] = [];
  for (let i = 0; i <= fileLines.length - expected.length; i++) {
    if (matchesAt(fileLines, i, expected, normalize)) matches.push(i);
  }
  return matches;
}

function uniqueMatch(fileLines: string[], expected: string[], normalize: (line: string) => string): number | null {
  const matches = findMatches(fileLines, expected, normalize);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return -1;
  return null;
}

function findChunkApplication(fileLines: string[], chunk: PatchChunk): { startIdx: number; removeLines: number; replaceDeletedOnly: boolean } {
  const anchored = chunk.oldStart - 1;
  const oldLines = oldComparableLines(chunk);
  if (oldLines.length === 0) return { startIdx: anchored, removeLines: chunk.oldLines, replaceDeletedOnly: false };
  const exact = (line: string) => line;
  const trimRight = (line: string) => line.replace(/[ \t]+$/g, "");

  if (matchesAt(fileLines, anchored, oldLines, exact)) return { startIdx: anchored, removeLines: chunk.oldLines, replaceDeletedOnly: false };

  const strategies: Array<{ lines: string[]; normalize: (line: string) => string; label: string }> = [
    { lines: oldLines, normalize: exact, label: "shifted context" },
    { lines: oldLines, normalize: trimRight, label: "trailing whitespace" },
  ];
  const deleted = deletedLines(chunk);
  if (deleted.length > 0 && deleted.length < oldLines.length) {
    strategies.push({ lines: deleted, normalize: exact, label: "unique deletion target" });
    strategies.push({ lines: deleted, normalize: trimRight, label: "unique deletion target with trailing whitespace" });
  }

  for (const strategy of strategies) {
    const match = uniqueMatch(fileLines, strategy.lines, strategy.normalize);
    if (match === -1) {
      throw new PatchApplicationError(`Patch conflict: ambiguous ${strategy.label} for hunk starting at line ${chunk.oldStart}`, {
        category: "ambiguous_context",
        hunk: chunk,
        expected: strategy.lines.join("\n"),
        actual: "multiple matches",
        line: chunk.oldStart,
      });
    }
    if (match !== null) {
      if (strategy.lines === deleted) {
        return { startIdx: match, removeLines: deleted.length, replaceDeletedOnly: true };
      }
      return { startIdx: match, removeLines: chunk.oldLines, replaceDeletedOnly: false };
    }
  }

  const actual = anchored >= 0 && anchored < fileLines.length ? fileLines[anchored]! : "EOF";
  throw new PatchApplicationError(`Patch conflict: expected "${oldLines[0] ?? ""}" at line ${anchored + 1} but found "${actual}"`, {
    category: "context_mismatch",
    hunk: chunk,
    expected: oldLines[0] ?? "",
    actual,
    line: anchored + 1,
  });
}
