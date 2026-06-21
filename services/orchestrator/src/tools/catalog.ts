import type { ToolSpec, PermissionProfile } from "@morrow/contracts";

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
];

/** Tool names the agent runtime actually implements (must match the catalog). */
export const IMPLEMENTED_TOOL_NAMES = ["inspect_workspace", "list_files", "read_file"] as const;

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
  deniedNamePatterns: [".env*", "*secret*", "*credential*", "*password*", "*key*", "*token*", "id_*"],
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
