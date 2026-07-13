import type { ToolSpec, PermissionProfile } from "@morrow/contracts";
import { DENIED_NAME_PATTERNS } from "../security/denied-name-patterns.js";

/**
 * Descriptive catalog of the safe, read-only tools the agent runtime exposes.
 * The execution definitions live in `execution/agent.ts`; this catalog is the
 * single source of truth for what the CLI and web render. A test asserts the
 * two stay in sync (see test/tools-catalog.test.ts).
 */
export const TOOL_CATALOG: ToolSpec[] = [
  {
    name: "inspect_workspace",
    title: "Inspect workspace",
    description: "Recursively list files in the project workspace (relative paths and sizes).",
    sideEffect: "read-only",
    enabled: true,
    parameters: {},
    constraints: [
      "Scoped to the project workspace root",
      "Bounded to 500 results and depth 8",
      "Never follows symlinks outside the workspace",
    ],
  },
  {
    name: "list_files",
    title: "List files",
    description: "List the contents of a directory relative to the workspace root.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { path: { type: "string", description: "Relative directory path (e.g. '.' or 'src')" } },
    constraints: ["Rejects absolute paths and '..' traversal", "Bounded to 100 results"],
  },
  {
    name: "read_file",
    title: "Read file",
    description: "Read the contents of a text file in the workspace.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { path: { type: "string", description: "Relative file path (e.g. 'package.json')" } },
    constraints: [
      "Rejects absolute paths, '..' traversal, and symlink escape",
      "Denies .morrow, .env, secret/credential/key/token files",
      "Rejects binary content and files larger than 100 KB",
      "Bounded by the active preset's context budget",
    ],
  },
  {
    name: "search_text",
    title: "Search text",
    description: "Search safe text files for a literal query.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { query: { type: "string", description: "Literal text to find" }, path: { type: "string", description: "Optional relative directory" } },
    constraints: [
      "Scoped to the project workspace root",
      "Skips secret, binary, and oversized files",
      "Bounded to 100 matches, 500 files, and one second",
    ],
  },
  {
    name: "search_files",
    title: "Search filenames",
    description: "Find safe workspace file paths containing a literal query.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { query: { type: "string", description: "Literal filename text to find" }, path: { type: "string", description: "Optional relative directory" } },
    constraints: [
      "Scoped to the project workspace root",
      "Skips secret paths",
      "Bounded to 100 matches, 500 files, and one second",
    ],
  },
  {
    name: "search_symbols",
    title: "Search symbols",
    description: "Search the project symbol index for functions, classes, methods, types, variables, and JSON config keys.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { query: { type: "string", description: "Symbol name or qualified-name text to find" }, limit: { type: "number", description: "Maximum results, up to 50" } },
    constraints: [
      "Scoped to the project symbol index",
      "Returns concise locations and metadata only",
      "Requires the index to be built with `morrow symbols rebuild`",
    ],
  },
  {
    name: "git_status",
    title: "Git status",
    description: "Inspect concise repository status without changing Git state.",
    sideEffect: "read-only",
    enabled: true,
    parameters: {},
    constraints: ["Runs fixed git status arguments in the project workspace", "Secret paths are filtered", "One-second timeout and 64 KB output cap"],
  },
  {
    name: "git_diff",
    title: "Git diff",
    description: "Inspect current unstaged unified diffs for safe paths.",
    sideEffect: "read-only",
    enabled: true,
    parameters: {},
    constraints: ["Runs fixed git diff arguments in the project workspace", "Secret paths and values are filtered", "One-second timeout and 64 KB output cap"],
  },
  {
    name: "git_log",
    title: "Git log",
    description: "Inspect recent commit metadata without changing Git state.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { limit: { type: "number", description: "Maximum recent commits, up to 20" } },
    constraints: ["Runs fixed git log arguments in the project workspace", "One-second timeout and 64 KB output cap"],
  },
  {
    name: "run_command",
    title: "Run command",
    description: "Run a safe, structured verification, build, test, or mutation command in the workspace.",
    sideEffect: "execute",
    enabled: true,
    parameters: {
      executable: { type: "string", description: "The executable name or path (e.g. 'pnpm' or 'git')" },
      args: { type: "array", items: { type: "string" }, description: "Arguments passed to the executable" },
      cwd: { type: "string", description: "Optional working directory relative to project root" },
      purpose: { type: "string", description: "Explain why this command is being run" }
    },
    constraints: [
      "Must not use shell: true",
      "Rejects shell metacharacters and privilege escalation",
      "Requires explicit user approval unless trusted",
      "Kills the process tree on timeout, cancellation, or task interruption"
    ],
  },
  {
    name: "propose_patch",
    title: "Propose patch",
    description: "Propose a unified diff patch to modify workspace files.",
    sideEffect: "write",
    enabled: true,
    parameters: {
      patch: { type: "string", description: "The unified diff content" },
      explanation: { type: "string", description: "Explain why this patch is proposed" },
      files: { type: "array", items: { type: "string" }, description: "Relative paths of files expected to change" }
    },
    constraints: [
      "Rejected if path traversal, absolute paths or escape occurs",
      "Rejected if files change between proposal and approval",
      "Creates backups under MORROW_HOME/backups",
      "Requires explicit user approval"
    ],
  }
];

/** Tool names the agent runtime actually implements (must match the catalog). */
export const IMPLEMENTED_TOOL_NAMES = ["inspect_workspace", "list_files", "read_file", "search_text", "search_files", "search_symbols", "git_status", "git_diff", "git_log", "run_command", "propose_patch"] as const;

export function getTool(name: string): ToolSpec | undefined {
  return TOOL_CATALOG.find((t) => t.name === name);
}

/**
 * The real permission boundaries enforced by the workspace safe-reader and the
 * agent runtime. These are descriptive of enforced behaviour, not aspirational.
 */
export const PERMISSION_PROFILE: PermissionProfile = {
  version: 1,
  toolProfileOptions: ["read-only", "none"],
  defaultToolProfile: "read-only",
  filesystemAccess: "read-only",
  shellExecution: false,
  networkAccess: "provider-only",
  writeAccess: false,
  deniedNamePatterns: DENIED_NAME_PATTERNS,
  deniedPathRules: [
    "Absolute paths are rejected",
    "Parent traversal ('..') is rejected",
    "The .morrow directory is rejected",
    "Symlinks resolving outside the workspace are rejected",
    "Unsupported binary content is rejected",
  ],
  limits: {
    maxFileBytes: 102400,
    maxInspectResults: 500,
    maxInspectDepth: 8,
  },
};
