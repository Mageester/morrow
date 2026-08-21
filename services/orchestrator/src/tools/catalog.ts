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
    description: "One-shot project discovery: top-level structure, manifests, README/AGENTS previews, and Git state. Takes no arguments. Use list_files, search_files, or search_text afterwards to look at anything specific.",
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
    description: "List the immediate contents of ONE workspace directory. Does not search — use search_files to find a file by name, or search_text to find a string inside files.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { path: { type: "string", description: "Directory path relative to the workspace root, e.g. '.' for the root or 'assets'. An absolute path inside the workspace is also accepted and is normalized for you." } },
    constraints: ["Paths must resolve inside the workspace; '..' traversal is rejected", "Bounded to 100 results"],
  },
  {
    name: "read_file",
    title: "Read file",
    description: "Read the contents of a text file in the workspace.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { path: { type: "string", description: "File path relative to the workspace root, e.g. 'index.html' or 'assets/site.css'. An absolute path inside the workspace is also accepted and is normalized for you." }, offset: { type: "number", description: "UTF-8 byte offset for paged reads" } },
    constraints: [
      "Paths must resolve inside the workspace; '..' traversal and symlink escape are rejected",
      "Denies .morrow, .env, secret/credential/key/token files",
      "Rejects binary content and pages large files with an explicit next offset",
      "Bounded by the active preset's context budget",
    ],
  },
  {
    name: "search_text",
    title: "Search text",
    description: "Search INSIDE workspace files for a literal string and return the matching lines. To find a file by its name instead, use search_files.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { query: { type: "string", description: "Literal text to find inside file contents. Not a regular expression or glob." }, path: { type: "string", description: "Optional directory to limit the search to, relative to the workspace root (e.g. 'assets'). Omit to search the whole workspace. An absolute path inside the workspace is also accepted." } },
    constraints: [
      "Scoped to the project workspace root",
      "Skips secret, binary, and oversized files",
      "Bounded to 100 matches, 500 files, and one second",
    ],
  },
  {
    name: "search_files",
    title: "Search filenames",
    description: "Find workspace files whose PATH OR NAME contains a literal string. Returns paths only, never file contents. To search inside file contents, use search_text.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { query: { type: "string", description: "Literal text to match against file paths, e.g. 'site.css' or 'assets/'. Not a regular expression or glob." }, path: { type: "string", description: "Optional directory to limit the search to, relative to the workspace root. Omit to search the whole workspace. An absolute path inside the workspace is also accepted." } },
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
    description: "Run a safe, structured verification, build, test, or mutation command in the workspace. Set background:true for a command that does not exit on its own (a dev server, a watcher) — it returns a processId immediately instead of waiting for exit; use read_process_output and stop_process to manage it.",
    sideEffect: "execute",
    enabled: true,
    parameters: {
      executable: { type: "string", description: "The executable name or path (e.g. 'pnpm' or 'git')" },
      args: { type: "array", items: { type: "string" }, description: "Arguments passed to the executable" },
      cwd: { type: "string", description: "Optional working directory relative to project root" },
      purpose: { type: "string", description: "Explain why this command is being run" },
      timeoutMs: { type: "number", description: "Optional shorter timeout in milliseconds; cannot exceed the command-policy ceiling" },
      background: { type: "boolean", description: "Start a long-running process (e.g. a dev server) without waiting for it to exit. Returns a processId instead of exit output." }
    },
    constraints: [
      "Must not use shell: true",
      "Rejects shell metacharacters and privilege escalation",
      "Requires explicit user approval unless trusted",
      "Foreground commands are killed on timeout, cancellation, or task interruption",
      "background:true commands keep running after the tool call returns; stop them with stop_process when done",
    ],
  },
  {
    name: "read_process_output",
    title: "Read process output",
    description: "Read captured stdout/stderr from a process started with run_command background:true.",
    sideEffect: "read-only",
    enabled: true,
    parameters: {
      processId: { type: "string", description: "The processId returned by the background run_command call" },
      stream: { type: "string", description: "'stdout' (default) or 'stderr'" },
      offset: { type: "number", description: "Byte offset to resume from (use the previous call's nextOffset); omit to read from the start" },
    },
    constraints: [
      "Scoped to processes owned by this project",
      "Bounded to 64 KB per read; page with the returned nextOffset",
    ],
  },
  {
    name: "stop_process",
    title: "Stop process",
    description: "Terminate a background process started with run_command background:true.",
    sideEffect: "execute",
    enabled: true,
    parameters: {
      processId: { type: "string", description: "The processId to terminate" },
      force: { type: "boolean", description: "Skip the graceful termination attempt and kill immediately" },
    },
    constraints: [
      "Scoped to processes owned by this project",
      "Graceful termination escalates to a forced kill after a short grace period",
    ],
  },
  {
    name: "write_plan",
    title: "Write plan",
    description: "Publish or update the task plan the user watches. Replaces the previous plan each call, so it is also how a step is marked running or done.",
    sideEffect: "read-only",
    enabled: true,
    parameters: { steps: { type: "array", description: "The complete ordered plan. Each step has a title and a status of pending, running, completed, failed, or skipped." } },
    constraints: ["Bounded to 20 steps", "Writes Morrow's plan record only, never a workspace file"],
  },
  {
    name: "ask_teammate",
    title: "Ask teammate",
    description: "Ask another enabled standalone teammate to work on one bounded objective. The target's identity, provider, model, policy, memory, and budget are resolved by Morrow; this always requires a fresh one-shot approval.",
    sideEffect: "execute",
    enabled: true,
    parameters: {
      agentId: { type: "string", description: "The durable named-agent id of the teammate to ask" },
      objective: { type: "string", description: "One bounded objective for the teammate, up to 2,000 characters" },
    },
    constraints: [
      "Exposed only to tasks running as a standalone named agent profile",
      "Target must be enabled, standalone, in this project, and different from the caller",
      "Always requires one-shot approval; auto-approval and project trust never apply",
      "The target's provider, model, tools, memory scopes, and budgets are resolved server-side",
      "Child execution is linked with parent_task_id and agent_id and receives no parent transcript",
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
      files: { type: "array", items: { type: "string" }, description: "Paths of files expected to change, relative to the workspace root" }
    },
    constraints: [
      "Rejected if the patch targets a path that does not resolve inside the workspace",
      "Rejected if files change between proposal and approval",
      "Creates backups under MORROW_HOME/backups",
      "Requires explicit user approval"
    ],
  },
  {
    name: "create_file", title: "Create file", description: "Create or completely replace one plain-text workspace file.", sideEffect: "write", enabled: true,
    parameters: {
      path: { type: "string", description: "File path relative to the workspace root, e.g. 'assets/site.css'. Missing parent directories are created. An absolute path inside the workspace is also accepted and is normalized for you." },
      content: { type: "string", description: "The COMPLETE final text of the file. Any existing content is replaced." },
      purpose: { type: "string", description: "One short line on why this file is being written." },
    },
    constraints: ["Paths must resolve inside the workspace", "Existing content is backed up", "Denied secret names remain blocked", "Runs directly in trusted-workspace mode"],
  },
  {
    name: "append_file", title: "Append file chunk", description: "Append an offset-fenced text chunk to a workspace file.", sideEffect: "write", enabled: true,
    parameters: {
      path: { type: "string", description: "File path relative to the workspace root. An absolute path inside the workspace is also accepted and is normalized for you." },
      content: { type: "string", description: "Text chunk to append." },
      expectedOffset: { type: "number", description: "Current file size in bytes, taken from the previous call's totalBytes. Use 0 for a new file." },
      purpose: { type: "string", description: "One short line on why this chunk is being appended." },
    },
    constraints: ["Paths must resolve inside the workspace", "Maximum 1 MiB per chunk", "Expected byte offset prevents replay duplication", "Existing content is backed up", "Denied secret names remain blocked"],
  },
  {
    name: "create_directory", title: "Create directory", description: "Create a workspace-contained directory recursively.", sideEffect: "write", enabled: true,
    parameters: { path: { type: "string", description: "Directory path relative to the workspace root, e.g. 'assets'. Parents are created too. An absolute path inside the workspace is also accepted and is normalized for you. create_file already creates missing parents, so this is only needed for an intentionally empty directory." } },
    constraints: ["Paths must resolve inside the workspace", "Denied names remain blocked", "Requires explicit approval unless agent auto-approval was selected"],
  },
  {
    name: "read_artifact", title: "Read stored tool output", description: "Read a byte range of an oversized tool result Morrow stored as an artifact.", sideEffect: "read-only", enabled: true,
    parameters: { id: { type: "string" }, offset: { type: "number" }, length: { type: "number" } },
    constraints: ["Only artifact ids referenced in this task's own tool results", "Returns at most 16 KB per call", "Reads Morrow-captured tool output, never the filesystem"],
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
  },
  {
    name: "read_mcp_resource", title: "Read MCP resource", description: "Read a resource URI from a configured MCP server (e.g. database schema, documentation, or application memory).", sideEffect: "read-only", enabled: true,
    parameters: { server: { type: "string", description: "MCP server name" }, uri: { type: "string", description: "Resource URI to read" } },
    constraints: ["Scoped to trusted MCP servers", "Returns structured text or binary blob metadata"],
  }
];

/** Tool names the agent runtime actually implements (must match the catalog). */
export const IMPLEMENTED_TOOL_NAMES = [
  "inspect_workspace", "list_files", "read_file", "search_text", "search_files", "search_symbols",
  "git_status", "git_diff", "git_log", "run_command", "read_process_output", "stop_process", "write_plan", "ask_teammate", "propose_patch", "create_file", "append_file", "create_directory",
  "read_artifact", "find_skill", "load_skill", "create_skill", "browser_open", "browser_snapshot", "browser_console", "browser_click",
  "browser_type", "browser_key", "browser_select", "browser_viewport", "browser_screenshot", "browser_download", "browser_close",
  "read_mcp_resource",
] as const;

/** Safety/read tools that remain present in every capability-scoped profile. */
export const TOOL_PROFILE_SAFETY_TOOLS = ["inspect_workspace", "read_file", "git_diff"] as const;

/** Stable labels used by the optimization selector and browser-safe review UI. */
export const TOOL_PROFILE_NAMES = ["read-only-workspace", "research", "coding", "browser", "full-agent"] as const;

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
