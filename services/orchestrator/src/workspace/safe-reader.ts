import { realpathSync, statSync, readFileSync } from "node:fs";
import { posix, win32, relative, resolve, sep, extname } from "node:path";
import { isWithinWorkspace } from "./path-boundary.js";
import { matchesDeniedNamePattern } from "../security/denied-name-patterns.js";

export class SafeReadError extends Error {
  readonly code = "safe_read_rejected";
  constructor(message: string) { super(message); }
}

function isAnyAbsolutePath(candidate: string): boolean {
  return posix.isAbsolute(candidate) || win32.isAbsolute(candidate);
}

function contained(root: string, target: string) {
  return isWithinWorkspace(root, target);
}

/**
 * Extensions that are never useful to read as text.
 *
 * This used to be an allowlist of "supported" text extensions, which meant any
 * ordinary source file nobody had thought of was rejected outright — a real
 * project could not be read because it contained `.prisma`, `.vue`, `.svelte`,
 * `.kt`, or `.tf`. An allowlist fails closed on exactly the files an agent is
 * asked to work on, and it can never be finished.
 *
 * Inverting it keeps every security control unchanged — workspace containment
 * and denied-name (credential/system file) checks still run below and are what
 * actually protect the user. This list only avoids streaming binary junk into
 * a model's context; the worst case of a miss is an unusual text file being
 * readable, which is the desired behaviour anyway.
 */
const BINARY_EXTENSIONS = new Set([
  // Images and media
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif", ".tiff", ".heic",
  ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac",
  ".mp4", ".avi", ".mov", ".mkv", ".webm", ".wmv",
  // Archives and disk images
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".iso", ".dmg",
  // Executables, objects, and debug artifacts
  ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib",
  ".class", ".jar", ".war", ".pyc", ".pyo", ".wasm", ".pdb", ".node",
  // Documents and fonts
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  // Databases and misc binary
  ".sqlite", ".sqlite3", ".db", ".mdb", ".dat", ".pack", ".idx",
]);

/**
 * True for a `.morrow` internal-tooling directory, or a name matching a
 * known credential/system-file convention — never a bare substring like
 * "secret" or "key", which would also match ordinary files that merely
 * discuss or check for credentials (`secrets.js`, `credential-detector.
 * test.js`, `keymap.ts`). See `security/denied-name-patterns.ts`.
 */
function isDeniedName(name: string): boolean {
  const value = name.toLowerCase();
  return value === ".morrow" || matchesDeniedNamePattern(value);
}

export function isDeniedWorkspacePath(requested: string): boolean {
  return requested.split(/[\\/]+/).filter(Boolean).some(isDeniedName);
}

export function validateSafeReadPath(root: string, requested: string): string {
  if (isAnyAbsolutePath(requested)) {
    throw new SafeReadError("Absolute paths are rejected");
  }
  const parts = requested.split(/[\\/]+/);
  if (parts.includes("..") || parts.includes(".morrow")) {
    throw new SafeReadError("Traversal and .morrow directory are rejected");
  }
  if (isDeniedWorkspacePath(requested)) {
    throw new SafeReadError("Access to secret or credential files is forbidden");
  }
  // Note: discovery-ignored paths (node_modules, dist, lockfiles, etc.) are
  // excluded from automatic discovery only. Explicit read requests for those
  // paths remain accessible — they are not universally forbidden.

  // Resolve candidate absolute path
  const candidate = resolve(root, requested);
  let target: string;
  try {
    target = realpathSync(candidate);
  } catch {
    throw new SafeReadError("File not found or inaccessible");
  }

  if (!contained(root, target)) {
    throw new SafeReadError("Workspace path is outside configured workspace");
  }

  const stat = statSync(target);
  if (!stat.isFile()) {
    throw new SafeReadError("Target is not a file");
  }

  // Enforce secret checks on file name
  const lastPart = parts[parts.length - 1];
  if (!lastPart) {
    throw new SafeReadError("Invalid path");
  }
  const nameOnly = lastPart.toLowerCase();

  // Reject binary formats; any other extension is treated as readable text.
  const ext = extname(nameOnly);
  if (BINARY_EXTENSIONS.has(ext)) {
    throw new SafeReadError(`${ext} is a binary file format and cannot be read as text`);
  }

  return target;
}

export function readWorkspaceFile(root: string, requested: string, maxBytes = 102400, offset = 0): {
  content: string;
  size: number;
  path: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  truncated: boolean;
} {
  const validatedPath = validateSafeReadPath(root, requested);
  const stat = statSync(validatedPath);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new SafeReadError("Read byte limit must be a positive integer");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) throw new SafeReadError(`Read offset must be between 0 and ${stat.size}`);
  const buf = readFileSync(validatedPath);
  
  // Check for binary content (null bytes)
  for (let i = 0; i < Math.min(buf.length, 512); i++) {
    if (buf[i] === 0) {
      throw new SafeReadError("Binary content detected in file");
    }
  }

  let end = Math.min(buf.length, offset + maxBytes);
  // Never split a UTF-8 sequence. If the byte immediately after the proposed
  // page boundary is a continuation byte, move the boundary back to the lead
  // byte and let the next page begin there.
  while (end < buf.length && end > offset && (buf[end]! & 0xc0) === 0x80) end--;
  const page = buf.subarray(offset, end);
  return {
    content: page.toString("utf-8"),
    size: stat.size,
    path: relative(root, validatedPath).split(sep).join("/"),
    offset,
    nextOffset: end,
    eof: end >= stat.size,
    truncated: end < stat.size,
  };
}
