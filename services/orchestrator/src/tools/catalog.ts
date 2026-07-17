import type { ToolSpec, PermissionProfile } from "@morrow/contracts";
import { DENIED_NAME_PATTERNS } from "../security/denied-name-patterns.js";

/**
 * Descriptive catalog of the tools the agent runtime exposes in agent mode.
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
  },
  {
    name: "create_file", title: "Create file", description: "Create one new plain-text workspace file.", sideEffect: "write", enabled: true,
    parameters: { path: { type: "string" }, content: { type: "string" }, purpose: { type: "string" } },
    constraints: ["Workspace-contained paths only", "Cannot overwrite", "Denied secret names remain blocked", "Requires explicit approval unless agent auto-approval was selected"],
  },
  {
    name: "create_directory", title: "Create directory", description: "Create a workspace-contained directory recursively.", sideEffect: "write", enabled: true,
    parameters: { path: { type: "string" } },
    constraints: ["Workspace-contained paths only", "Denied names remain blocked", "Requires explicit approval unless agent auto-approval was selected"],
  },
  {
    name: "find_skill", title: "Find skill", description: "Search installed project and Morrow skills by keyword.", sideEffect: "read-only", enabled: true,
    parameters: { query: { type: "string" } }, constraints: ["Reads manifests only from configured skill roots", "Returns at most 10 results"],
  },
  {
    name: "load_skill", title: "Load skill", description: "Load the instructions for one validated installed skill ID.", sideEffect: "read-only", enabled: true,
    parameters: { skill_id: { type: "string" } }, constraints: ["Kebab-case skill IDs only", "Reads only SKILL.md under configured skill roots"],
  },
  {
    name: "create_skill", title: "Create skill", description: "Create a reusable skill bundle under the configured skill root.", sideEffect: "write", enabled: true,
    parameters: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, instructions: { type: "string" }, requestedTools: { type: "array" }, riskClass: { type: "string" }, overwrite: { type: "boolean" } },
    constraints: ["Validated skill IDs, tools, and risk class", "Checksummed generated instructions", "Backs up explicit overwrites", "Cannot silently enable the generated skill"],
  },
  {
    name: "browser_open", title: "Open browser page", description: "Open an HTTP(S) page in a task-scoped controlled browser.", sideEffect: "network", enabled: true,
    parameters: { url: { type: "string" } },
    constraints: ["Exact origin requires a durable visible approval", "HTTP(S) only; URL credentials rejected", "Private/loopback access requires the approved hostname", "Session approval excludes credentials, payments, purchases, destructive account actions, releases, deploys, and pushes"],
  },
  {
    name: "browser_snapshot", title: "Inspect browser DOM", description: "Capture sanitized page text, semantic references, title, URL, and viewport.", sideEffect: "read-only", enabled: true,
    parameters: {}, constraints: ["Page content is untrusted data", "Prompt-injection patterns are neutralized", "Text and semantic references are bounded"],
  },
  {
    name: "browser_console", title: "Inspect browser console", description: "Read sanitized console and page-error evidence.", sideEffect: "read-only", enabled: true,
    parameters: {}, constraints: ["Returns at most 100 recent console/page-error records", "Injection and secret-like data are sanitized in audit output"],
  },
  {
    name: "browser_click", title: "Click browser element", description: "Click a semantic reference from the latest page snapshot.", sideEffect: "execute", enabled: true,
    parameters: { ref: { type: "string" } }, constraints: ["Stale/unknown references rejected", "Purchase, payment, account deletion, release, deploy, and push actions categorically blocked"],
  },
  {
    name: "browser_type", title: "Fill browser field", description: "Fill a semantic text-field reference.", sideEffect: "execute", enabled: true,
    parameters: { ref: { type: "string" }, text: { type: "string" } }, constraints: ["Password inputs are not exposed", "Credential, token, secret, and payment fields categorically blocked"],
  },
  {
    name: "browser_key", title: "Send browser key", description: "Send a bounded keyboard key name to the active page.", sideEffect: "execute", enabled: true,
    parameters: { key: { type: "string" } }, constraints: ["Key names are limited to 100 characters", "Task cancellation aborts the action"],
  },
  {
    name: "browser_select", title: "Select browser option", description: "Select an option using a semantic element reference.", sideEffect: "execute", enabled: true,
    parameters: { ref: { type: "string" }, value: { type: "string" } }, constraints: ["Stale/unknown references rejected", "Scoped to the approved browser session"],
  },
  {
    name: "browser_viewport", title: "Set browser viewport", description: "Set desktop, tablet, mobile, or bounded custom viewport dimensions.", sideEffect: "execute", enabled: true,
    parameters: { preset: { type: "string" }, width: { type: "number" }, height: { type: "number" }, label: { type: "string" } }, constraints: ["Each dimension must be between 320 and 2560 pixels", "Changing viewport invalidates old element references"],
  },
  {
    name: "browser_screenshot", title: "Capture browser screenshot", description: "Save a bounded PNG as durable task evidence and optionally attach it ephemerally for vision analysis.", sideEffect: "write", enabled: true,
    parameters: { label: { type: "string" } }, constraints: ["Stored only under the task artifact directory", "Maximum 5 MB", "Vision bytes attach only for a model with verified vision metadata", "Base64 is never persisted in conversation or tool output"],
  },
  {
    name: "browser_download", title: "Download browser artifact", description: "Save a browser download under the controlled task directory.", sideEffect: "write", enabled: true,
    parameters: { ref: { type: "string" } }, constraints: ["Filename is sanitized", "Destination is contained under the task download root", "Recorded as durable task evidence"],
  },
  {
    name: "browser_close", title: "Close browser session", description: "Close and release the current task-scoped browser session.", sideEffect: "execute", enabled: true,
    parameters: {}, constraints: ["Idempotent", "All task exit paths also close an open session"],
  }
];

/** Tool names the agent runtime actually implements (must match the catalog). */
export const IMPLEMENTED_TOOL_NAMES = [
  "inspect_workspace", "list_files", "read_file", "search_text", "search_files", "search_symbols",
  "git_status", "git_diff", "git_log", "run_command", "propose_patch", "create_file", "create_directory",
  "find_skill", "load_skill", "create_skill", "browser_open", "browser_snapshot", "browser_console", "browser_click",
  "browser_type", "browser_key", "browser_select", "browser_viewport", "browser_screenshot", "browser_download", "browser_close",
] as const;

export function getTool(name: string): ToolSpec | undefined {
  return TOOL_CATALOG.find((t) => t.name === name);
}

/**
 * The real permission boundaries enforced by the workspace safe-reader and the
 * agent runtime. These are descriptive of enforced behaviour, not aspirational.
 */
export const PERMISSION_PROFILE: PermissionProfile = {
  version: 1,
  toolProfileOptions: ["agent", "read-only", "none"],
  defaultToolProfile: "agent",
  filesystemAccess: "workspace-write",
  shellExecution: true,
  networkAccess: "enabled",
  writeAccess: true,
  deniedNamePatterns: DENIED_NAME_PATTERNS,
  deniedPathRules: [
    "Absolute paths are rejected",
    "Parent traversal ('..') is rejected",
    "The .morrow directory is rejected",
    "Symlinks resolving outside the workspace are rejected",
    "Unsupported binary content is rejected",
    "Commands and writes require approval unless explicit agent auto-approval is selected",
    "Browser navigation requires an origin-scoped approval and excludes material external actions",
  ],
  limits: {
    maxFileBytes: 102400,
    maxInspectResults: 500,
    maxInspectDepth: 8,
  },
};
