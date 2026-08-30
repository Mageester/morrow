import { basename, dirname, join, resolve, relative } from "node:path";
import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAnyAbsolutePath, normalizeWorkspacePath } from "../workspace/path-boundary.js";

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
 * Build a unified diff that replaces an existing file's entire contents. This
 * is the automatic fallback when `create_file` targets a path that already
 * exists: instead of failing with "it already exists, use an edit patch", the
 * runtime synthesizes this whole-file edit and flows it through the identical
 * validate → approve → apply → change-set pipeline, so the existing file is
 * backed up and the change is undoable.
 *
 * The old side (`-` lines) is split with the same `/\r?\n/`-equivalent
 * normalization the applier uses, so the deletion context matches the file on
 * disk regardless of CRLF/LF. Line endings in the written result are chosen by
 * `applyUnifiedPatch` from the original file, matching the rest of the pipeline.
 */
export function buildReplacementDiff(relPath: string, oldContent: string, newContent: string): string {
  const target = relPath.replace(/\\/g, "/");
  const oldLines = oldContent.replace(/\r\n/g, "\n").split("\n");
  const newLines = newContent.replace(/\r\n/g, "\n").split("\n");
  const body = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
  return `--- a/${target}\n+++ b/${target}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${body}\n`;
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
        // A line starting with "--- " or "@@ " never reaches this branch —
        // the outer if/else-if chain above already intercepts those as the
        // next file or hunk header. Anything that does reach here is inside
        // an open hunk and carries none of the three valid markers (space,
        // -, +) — not a structural boundary, a malformed hunk body, most
        // often a model dropping the leading context-space on a line. This
        // used to be silently discarded here, ending chunk collection early
        // with no signal; the remaining, dropped lines (here, everything
        // after the bad line) never became part of the patch at all. Before
        // hunk line counts were tolerantly repaired, that silent truncation
        // was usually caught downstream by the header no longer matching the
        // (now-shorter) body — but a repair that trusts the body's own count
        // removes that accidental safety net, so a truncated hunk can apply
        // "successfully" with silently missing content. Failing loudly here
        // is the direct fix, not a narrower header-repair.
        throw new Error(`Malformed patch: hunk line lacks a valid +/-/space prefix: ${JSON.stringify(line)}`);
      }
    }
  }

  // Validate hunk line counts
  for (const file of files) {
    for (const chunk of file.chunks) {
      let expectedOld = 0;
      let expectedNew = 0;
      let additionLines = 0;
      for (const chunkLine of chunk.lines) {
        const prefix = chunkLine.charAt(0);
        if (prefix === " " || prefix === "-") expectedOld++;
        if (prefix === " " || prefix === "+") expectedNew++;
        if (prefix === "+") additionLines++;
      }
      if (expectedOld !== chunk.oldLines || expectedNew !== chunk.newLines) {
        // A well-formed hunk — even a pure deletion with no replacement —
        // already has correct header counts and never reaches this branch at
        // all. Landing here with zero real "+" lines is inherently
        // suspicious: either a rare arithmetic slip on a genuine
        // pure-deletion edit, or — reproduced directly — a model that
        // generated a diff and got cut off mid-hunk (token limit, connection
        // drop) before ever writing the "+" line it intended. Both a
        // net-growth header (@@ -1,5 +1,9 @@) and a net-shrink header
        // (@@ -1,5 +1,2 @@) truncated right after the deletion line applied
        // "successfully" under a naive repair and silently deleted the
        // target line with nothing put back — reporting success while
        // quietly losing content, worse than the hard failure it replaced.
        // The asymmetric cost — a false reject just asks the model to retry;
        // a false accept silently corrupts the file — means zero additions
        // in a mismatched hunk is refused outright, regardless of which
        // direction the header's arithmetic was wrong in.
        if (additionLines === 0) {
          throw new Error(
            `Hunk line count mismatch for ${file.newPath}: @@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@. Expected old=${chunk.oldLines}, actual=${expectedOld}. Expected new=${chunk.newLines}, actual=${expectedNew}. The header promises added content this hunk never provides — this looks like a truncated patch, not a miscounted header.`
          );
        }
        // Otherwise: models frequently miscount lines in hunk headers (e.g.
        // @@ -19,7 +19,9 @@) on an otherwise complete, unambiguous edit.
        // Repair the header using the true line counts rather than reject a
        // valid patch over pure arithmetic.
        chunk.oldLines = expectedOld;
        chunk.newLines = expectedNew;
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
  const check = (rawPath: string) => {
    if (rawPath === "/dev/null") return;
    // A patch header naming a workspace file absolutely still targets that
    // file; normalize it and let the containment check below decide.
    const normalization = normalizeWorkspacePath(workspacePath, rawPath);
    if (!normalization.ok) {
      throw new Error(`${normalization.message} Example: "${normalization.example}".`);
    }
    const relPath = normalization.path;
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
  // An absolute path that resolves inside the workspace names a legitimate
  // write target; normalize it instead of refusing it. The real-root symlink
  // containment below is unchanged and remains the deciding check.
  const normalization = normalizeWorkspacePath(workspaceRoot, relPath);
  if (!normalization.ok) {
    throw new Error(`${normalization.message} Example: "${normalization.example}".`);
  }
  const normalized = normalization.path.replace(/\\/g, "/");
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
  // For an insertion-only hunk, oldStart is the zero-width boundary between
  // old lines. The non-empty case uses oldStart - 1 as the first line to
  // match, but subtracting one here inserts before that line instead.
  if (oldLines.length === 0) return { startIdx: Math.max(0, chunk.oldStart), removeLines: chunk.oldLines, replaceDeletedOnly: false };
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
