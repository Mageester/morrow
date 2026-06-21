import { basename, dirname, join, resolve, relative, isAbsolute } from "node:path";
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

export function hashString(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
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
    if (isAbsolute(relPath)) {
      throw new Error(`Absolute paths are rejected: ${relPath}`);
    }
    const normalized = relPath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    if (parts.includes("..") || parts.includes(".git")) {
      throw new Error(`Parent traversal and .git paths are rejected: ${relPath}`);
    }
    const resolved = resolve(workspacePath, relPath);
    const rel = relative(workspacePath, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
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
    // File creation (--- /dev/null) and deletion (+++ /dev/null) are not yet
    // implemented or tested; reject them rather than half-applying.
    if (file.oldPath === "/dev/null") {
      throw new Error("File creation is not supported yet");
    }
    if (file.newPath === "/dev/null") {
      throw new Error("File deletion is not supported yet");
    }
    check(file.oldPath);
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
  if (isAbsolute(relPath)) {
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
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`Path escapes the workspace via symlink or traversal: ${relPath}`);
  }
  return candidate;
}

export function applyUnifiedPatch(
  fileContent: string | null, // null if file is being created
  chunks: PatchChunk[]
): string {
  let fileLines = fileContent !== null ? fileContent.split(/\r?\n/) : [];

  // Sort chunks by oldStart descending to apply modifications from bottom to top
  const sortedChunks = [...chunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const chunk of sortedChunks) {
    const startIdx = chunk.oldStart - 1;
    let fileIdx = startIdx;
    const newLinesToInsert: string[] = [];

    // Verify context and deletion lines match exactly
    for (const chunkLine of chunk.lines) {
      const prefix = chunkLine.charAt(0);
      const lineText = chunkLine.slice(1);

      if (prefix === " " || prefix === "-") {
        if (fileIdx < 0 || fileIdx >= fileLines.length || fileLines[fileIdx] !== lineText) {
          throw new Error(
            `Patch conflict: expected "${lineText}" at line ${fileIdx + 1} but found "${
              fileIdx >= 0 && fileIdx < fileLines.length ? fileLines[fileIdx] : "EOF"
            }"`
          );
        }
        fileIdx++;
      }
    }

    // Build the insertion segment
    for (const chunkLine of chunk.lines) {
      const prefix = chunkLine.charAt(0);
      const lineText = chunkLine.slice(1);
      if (prefix === " " || prefix === "+") {
        newLinesToInsert.push(lineText);
      }
    }

    fileLines.splice(startIdx, chunk.oldLines, ...newLinesToInsert);
  }

  return fileLines.join("\n");
}
