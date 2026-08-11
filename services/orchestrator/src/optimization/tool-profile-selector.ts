import type { ToolSpec } from "@morrow/contracts";
import {
  IMPLEMENTED_TOOL_NAMES,
  TOOL_CATALOG,
  TOOL_PROFILE_NAMES,
  TOOL_PROFILE_SAFETY_TOOLS,
} from "../tools/catalog.js";

export type ToolProfileName = (typeof TOOL_PROFILE_NAMES)[number];
export type ToolTaskClassification = "workspace_read" | "research" | "coding" | "browser" | "full_agent";

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
] as const;

const RESEARCH = [
  ...READ_ONLY_WORKSPACE,
  "browser_open", "browser_snapshot", "browser_console", "browser_close",
] as const;

const CODING = [
  ...READ_ONLY_WORKSPACE,
  "run_command", "read_process_output", "stop_process", "propose_patch", "create_file",
  "append_file", "create_directory", "create_skill",
] as const;

const BROWSER = [
  ...READ_ONLY_WORKSPACE,
  "browser_open", "browser_snapshot", "browser_console", "browser_click", "browser_type",
  "browser_key", "browser_select", "browser_viewport", "browser_screenshot", "browser_download", "browser_close",
] as const;

const PROFILE_TOOLS: Record<ToolProfileName, readonly string[]> = {
  "read-only-workspace": READ_ONLY_WORKSPACE,
  research: RESEARCH,
  coding: CODING,
  browser: BROWSER,
  "full-agent": IMPLEMENTED_TOOL_NAMES,
};

const REQUIRED_SAFETY_TOOLS: Record<ToolTaskClassification, readonly string[]> = {
  workspace_read: TOOL_PROFILE_SAFETY_TOOLS,
  research: TOOL_PROFILE_SAFETY_TOOLS,
  coding: [...TOOL_PROFILE_SAFETY_TOOLS, "propose_patch"],
  browser: TOOL_PROFILE_SAFETY_TOOLS,
  full_agent: TOOL_PROFILE_SAFETY_TOOLS,
};

function profileForClassification(classification: ToolTaskClassification): ToolProfileName {
  switch (classification) {
    case "workspace_read": return "read-only-workspace";
    case "research": return "research";
    case "coding": return "coding";
    case "browser": return "browser";
    case "full_agent": return "full-agent";
  }
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
