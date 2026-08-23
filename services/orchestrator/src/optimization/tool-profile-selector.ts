import type { ToolSpec } from "@morrow/contracts";
import {
  IMPLEMENTED_TOOL_NAMES,
  TOOL_CATALOG,
  TOOL_PROFILE_NAMES,
  TOOL_PROFILE_SAFETY_TOOLS,
} from "../tools/catalog.js";

export type ToolProfileName = (typeof TOOL_PROFILE_NAMES)[number];
export type ToolTaskClassification = "workspace_read" | "research" | "coding_focused" | "coding" | "browser" | "full_agent";

export interface ToolProfileRequest {
  classification: ToolTaskClassification;
  requiredTools?: readonly string[];
}

export interface ToolProfileSelection {
  profile: ToolProfileName;
  tools: string[];
  toolSpecs: ToolSpec[];
  reason: string;
  fallbackPath: "full-agent";
}

const READ_ONLY_WORKSPACE = [
  "inspect_workspace", "list_files", "read_file", "search_text", "search_files", "search_symbols",
  "git_status", "git_diff", "git_log", "read_artifact", "find_skill", "load_skill",
  // Every profile spreads from this list, and a plan is worth having on all of
  // them — a coding task is exactly the one a user wants a checklist for.
  // It writes Morrow's own plan record and never a workspace file, so it costs
  // the read-only profiles nothing.
  "write_plan",
] as const;

const RESEARCH = [
  ...READ_ONLY_WORKSPACE,
  "browser_open", "browser_snapshot", "browser_console", "browser_close",
] as const;

// Bounded file work that names its targets does not need background-process,
// skill-authoring, team, or broad repository-history schemas. It retains every
// tool needed to inspect, edit, run verification, and retrieve large results.
const CODING_FOCUSED = [
  "inspect_workspace", "list_files", "read_file", "search_text", "search_files",
  "git_diff", "run_command", "propose_patch", "create_file", "append_file", "read_artifact", "record_decision",
] as const;

const CODING = [
  ...READ_ONLY_WORKSPACE,
  "run_command", "read_process_output", "stop_process", "propose_patch", "create_file",
  "append_file", "create_directory", "create_skill", "record_decision",
] as const;

const BROWSER = [
  ...READ_ONLY_WORKSPACE,
  "browser_open", "browser_snapshot", "browser_console", "browser_click", "browser_type",
  "browser_key", "browser_select", "browser_viewport", "browser_screenshot", "browser_download", "browser_close",
] as const;

const PROFILE_TOOLS: Record<ToolProfileName, readonly string[]> = {
  "read-only-workspace": READ_ONLY_WORKSPACE,
  research: RESEARCH,
  "coding-focused": CODING_FOCUSED,
  coding: CODING,
  browser: BROWSER,
  "full-agent": IMPLEMENTED_TOOL_NAMES,
};

const REQUIRED_SAFETY_TOOLS: Record<ToolTaskClassification, readonly string[]> = {
  workspace_read: TOOL_PROFILE_SAFETY_TOOLS,
  research: TOOL_PROFILE_SAFETY_TOOLS,
  coding_focused: [...TOOL_PROFILE_SAFETY_TOOLS, "propose_patch"],
  coding: [...TOOL_PROFILE_SAFETY_TOOLS, "propose_patch"],
  browser: TOOL_PROFILE_SAFETY_TOOLS,
  full_agent: TOOL_PROFILE_SAFETY_TOOLS,
};

function profileForClassification(classification: ToolTaskClassification): ToolProfileName {
  switch (classification) {
    case "workspace_read": return "read-only-workspace";
    case "research": return "research";
    case "coding_focused": return "coding-focused";
    case "coding": return "coding";
    case "browser": return "browser";
    case "full_agent": return "full-agent";
  }
}

/**
 * Classify only when the prompt supplies enough evidence to retain the needed
 * escape hatches. A focused coding profile requires at least one explicit file
 * target and no signal for browser, skill, team, process, or repository-wide
 * work; everything ambiguous stays on the broader profile.
 */
export function classifyToolTask(prompt: string, mode: "agent" | string): ToolTaskClassification {
  if (mode !== "agent") return "workspace_read";
  if (/\b(?:browser|webpage|web\s+page|website|dom|screenshot|viewport|console\s+error|url|visually)\b/i.test(prompt)) return "browser";
  const coding = /\b(?:build|implement|code|write|edit|patch|create|fix|refactor|test|develop)\b/i.test(prompt);
  if (coding) {
    const namesFile = /(?:^|[\s`'"(])(?:[\w@.-]+\/)*[\w@.-]+\.[a-z0-9]{1,10}\b/i.test(prompt);
    const needsBroadCapability = /\b(?:repository|repo|codebase|architecture|refactor|redesign|migrate|skill|teammate|team|mission|plan|background|server|watcher|process|directory|research|sources?|citations?)\b/i.test(prompt);
    return namesFile && !needsBroadCapability ? "coding_focused" : "coding";
  }
  if (/\b(?:research|sources?|citations?|current|latest|news|web\s+search)\b/i.test(prompt)) return "research";
  if (/\b(?:inspect|list|read|search|review|analy[sz]e)\b/i.test(prompt)) return "workspace_read";
  return "full_agent";
}

export class ToolProfileSelector {
  private readonly catalog: readonly ToolSpec[];

  constructor(catalog: readonly ToolSpec[] = TOOL_CATALOG) {
    this.catalog = catalog;
  }

  select(request: ToolProfileRequest): ToolProfileSelection {
    const requestedProfile = profileForClassification(request.classification);
    const configured = new Set(PROFILE_TOOLS[requestedProfile]);
    const required = new Set([
      ...REQUIRED_SAFETY_TOOLS[request.classification],
      ...(request.requiredTools ?? []),
    ]);
    const missing = [...required].filter((name) => !configured.has(name));
    const profile = missing.length > 0 ? "full-agent" : requestedProfile;
    const selectedNames = profile === "full-agent"
      ? [...IMPLEMENTED_TOOL_NAMES]
      : [...PROFILE_TOOLS[profile]];
    const catalogNames = new Set(this.catalog.map((tool) => tool.name));
    const unknown = selectedNames.filter((name) => !catalogNames.has(name));
    if (unknown.length > 0) {
      throw new Error(`Tool profile ${profile} references missing catalog tools: ${unknown.join(", ")}`);
    }
    const tools = selectedNames.filter((name) => catalogNames.has(name));
    const toolSpecs = tools.map((name) => this.catalog.find((tool) => tool.name === name)!).filter(Boolean);
    const reason = missing.length > 0
      ? `Required capability ${missing.join(", ")} is outside ${requestedProfile}; restored the complete catalog for safety.`
      : `Selected the smallest safe ${requestedProfile} profile for ${request.classification}; required safety tools remain present.`;
    return { profile, tools, toolSpecs, reason, fallbackPath: "full-agent" };
  }
}

export function selectToolProfile(request: ToolProfileRequest, catalog: readonly ToolSpec[] = TOOL_CATALOG): ToolProfileSelection {
  return new ToolProfileSelector(catalog).select(request);
}
