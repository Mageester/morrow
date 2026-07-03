/**
 * Discovery ignore rules for Morrow workspace inspection.
 *
 * These are DISCOVERY exclusions only — they reduce noise during automatic
 * project scanning. They do NOT prevent explicit user/model requests from
 * reading lockfiles, vendor code, generated output, source maps, etc.
 * The safe-reader enforces only hard protection: path traversal, secrets,
 * binary content, and workspace containment.
 */

const IGNORED_DIR_NAMES = new Set([
  ".git", ".hg", ".svn", ".morrow", ".hermes",
  "node_modules", "bower_components", "vendor",
  "dist", "build", "out",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".vite",
  "coverage", "target",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".pnpm-store",
  "tmp", "temp", "logs",
]);

const IGNORED_FILE_NAMES = new Set([
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb",
  "composer.lock", "poetry.lock", "cargo.lock",
]);

const IGNORED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
  ".mp4", ".mov", ".avi", ".mkv", ".mp3", ".wav", ".flac",
  ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".pdf",
]);

/** Normalise a path to forward-slash POSIX form for consistent matching. */
function normalizePath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join("/");
}

export function isBuiltInIgnoredName(name: string, isDirectory: boolean): boolean {
  const lower = name.toLowerCase();
  if (isDirectory && IGNORED_DIR_NAMES.has(lower)) return true;
  if (!isDirectory && IGNORED_FILE_NAMES.has(lower)) return true;
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  return !isDirectory && IGNORED_EXTENSIONS.has(ext);
}

export function isBuiltInIgnoredPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.some((part, index) => isBuiltInIgnoredName(part, index < parts.length - 1));
}

// ── .gitignore matcher ────────────────────────────────────────────────
//
// We implement a minimal but correct .gitignore matcher that handles:
// - simple patterns (foo.txt)
// - directory-only patterns (build/)
// - path patterns with slashes (src/temp/)
// - glob wildcards (* and ?)
// - negation rules (!pattern)
// - comments (#)
// - empty lines (skipped)
//
// The matcher respects .gitignore semantics: a parent directory match
// excludes all children, and a negation can re-include a file that was
// excluded by a broader pattern.

interface GitignoreRule {
  pattern: string;
  regex: RegExp;
  directoryOnly: boolean;
  hasSlash: boolean;
  negate: boolean;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function parseGitignoreLine(line: string): GitignoreRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const negate = trimmed.startsWith("!");
  const body = negate ? trimmed.slice(1) : trimmed;
  const directoryOnly = body.endsWith("/");
  const pattern = body.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!pattern) return null;
  const hasSlash = pattern.includes("/");
  // For path patterns (with slash), match against the full relative path.
  // For simple patterns, match against the filename or any path component.
  const regex = globToRegex(pattern.split("/").pop() || pattern);
  return { pattern, regex, directoryOnly, hasSlash, negate };
}

function readGitignoreRules(root: string, readText: (path: string) => string | null): GitignoreRule[] {
  const raw = readText(`${root.replace(/[\\/]+$/, "")}/.gitignore`);
  if (!raw) return [];
  const rules: GitignoreRule[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const rule = parseGitignoreLine(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Create a .gitignore-aware matcher for workspace paths.
 * Returns a function `(relativePath, isDirectory) => boolean` that returns
 * `true` if the path should be ignored during discovery.
 *
 * Negation rules are handled correctly: a file matched by a negation rule
 * is NOT ignored even if an earlier broader rule would ignore it.
 */
export function createGitignoreMatcher(
  root: string,
  readText: (path: string) => string | null
): (relativePath: string, isDirectory: boolean) => boolean {
  const rules = readGitignoreRules(root, readText);
  if (rules.length === 0) return () => false;

  return (relativePath: string, isDirectory: boolean): boolean => {
    const normalized = normalizePath(relativePath);
    if (!normalized) return false;
    const name = normalized.split("/").pop() ?? normalized;

    let ignored = false;
    for (const rule of rules) {
      let matches: boolean;
      if (rule.hasSlash) {
        // Path pattern: match against full relative path
        matches = normalized === rule.pattern || rule.regex.test(normalized) || normalized.startsWith(rule.pattern + "/");
      } else {
        // Simple pattern: match against filename or any path component
        matches = rule.regex.test(name) || normalized.split("/").some((part) => rule.regex.test(part));
      }
      if (rule.directoryOnly) {
        // Directory-only rule: only match directories or paths inside the dir
        if (!isDirectory && !normalized.startsWith(rule.pattern + "/")) {
          matches = false;
        }
      }
      if (matches) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  };
}
