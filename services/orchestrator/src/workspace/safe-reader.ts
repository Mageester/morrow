import { realpathSync, statSync, readFileSync } from "node:fs";
import { posix, win32, relative, resolve, sep, extname } from "node:path";

export class SafeReadError extends Error {
  readonly code = "safe_read_rejected";
  constructor(message: string) { super(message); }
}

function isAnyAbsolutePath(candidate: string): boolean {
  return posix.isAbsolute(candidate) || win32.isAbsolute(candidate);
}

function contained(root: string, target: string) {
  return target === root || target.startsWith(`${root}${sep}`);
}

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".html", ".css",
  ".yaml", ".yml", ".mjs", ".cjs", ".toml", ".config", ".xml", ".ini",
  ".sh", ".bat", ".ps1", ".py", ".go", ".rs", ".java", ".c", ".cpp",
  ".h", ".cs", ".rb", ".php", ".sql", ".gradle", ".properties", ""
]);

function isDeniedName(name: string): boolean {
  const value = name.toLowerCase();
  return value === ".morrow" || value.startsWith(".env") || value.includes("secret") || value.includes("credential") || value.includes("password") || value.includes("key") || value.includes("token") || value.startsWith("id_");
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

  // Enforce supported text extensions
  const ext = extname(nameOnly);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new SafeReadError(`File extension ${ext || "binary"} is not supported in this milestone`);
  }

  return target;
}

export function readWorkspaceFile(root: string, requested: string, maxBytes = 102400): { content: string; size: number; path: string } {
  const validatedPath = validateSafeReadPath(root, requested);
  const stat = statSync(validatedPath);
  
  if (stat.size > maxBytes) {
    throw new SafeReadError(`File size exceeds limit of ${maxBytes / 1024} KB`);
  }

  const buf = readFileSync(validatedPath);
  
  // Check for binary content (null bytes)
  for (let i = 0; i < Math.min(buf.length, 512); i++) {
    if (buf[i] === 0) {
      throw new SafeReadError("Binary content detected in file");
    }
  }

  return {
    content: buf.toString("utf-8"),
    size: stat.size,
    path: relative(root, validatedPath).split(sep).join("/")
  };
}
