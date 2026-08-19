/**
 * How a tool call is put into words, in both tenses.
 *
 * One table rather than two, because the settled work rows ("Read
 * package.json") and the live activity line ("Reading package.json") are the
 * same sentence about the same call, and letting them drift is how a turn ends
 * up describing itself differently depending on whether it has finished.
 *
 * `stem` exists because a tool's `purpose` is usually already an imperative
 * phrase — `run_command` arrives with `purpose: "Run pnpm test"`. Composing
 * verb and target blindly produced "Ran Run pnpm test", so the leading verb is
 * recognised and dropped before the tense is applied.
 */
export interface ToolVerb {
  past: string;
  present: string;
  /** Leading word of a `purpose` that this verb would duplicate. Absent for
   *  verbs that already carry their own object and take no target. */
  stem?: string;
}

export const TOOL_VERBS = new Map<string, ToolVerb>([
  ["read_file", { past: "Read", present: "Reading", stem: "read" }],
  ["write_file", { past: "Wrote", present: "Writing", stem: "write" }],
  ["create_file", { past: "Created", present: "Creating", stem: "create" }],
  ["edit_file", { past: "Edited", present: "Editing", stem: "edit" }],
  ["apply_patch", { past: "Patched", present: "Patching", stem: "patch" }],
  ["delete_file", { past: "Deleted", present: "Deleting", stem: "delete" }],
  ["list_files", { past: "Listed", present: "Listing", stem: "list" }],
  ["search_files", { past: "Searched for", present: "Searching for", stem: "search" }],
  ["search_text", { past: "Searched for", present: "Searching for", stem: "search" }],
  ["search_symbols", { past: "Looked up", present: "Looking up", stem: "find" }],
  ["run_command", { past: "Ran", present: "Running", stem: "run" }],
  ["inspect_workspace", { past: "Inspected the workspace", present: "Inspecting the workspace" }],
  ["git_status", { past: "Checked git status", present: "Checking git status" }],
  ["git_diff", { past: "Read the git diff", present: "Reading the git diff" }],
  ["git_log", { past: "Read the git log", present: "Reading the git log" }],
  ["browser_open", { past: "Opened", present: "Opening", stem: "open" }],
  ["browser_click", { past: "Clicked", present: "Clicking", stem: "click" }],
  ["fetch_url", { past: "Fetched", present: "Fetching", stem: "fetch" }],
  ["web_search", { past: "Searched the web for", present: "Searching the web for", stem: "search" }],
]);

/** Drops a leading imperative the verb is about to say again. */
export function stripLeadingVerb(target: string, stem: string | undefined): string {
  if (!stem) return target;
  const match = target.match(/^(\S+)\s+(.*)$/);
  const first = match?.[1]?.toLowerCase().replace(/[^a-z]/g, "");
  if (!match || !first) return target;
  // Tolerates the forms the same verb arrives in: run / runs / running / ran.
  const matches = first === stem || first === `${stem}s` || first === `${stem}ing` || first === `${stem}ed`;
  return matches ? match[2]! : target;
}

/** Compose one tool call into a phrase in the requested tense. */
export function phrase(name: string, target: string | undefined, tense: "past" | "present"): string {
  const verb = TOOL_VERBS.get(name);
  const trimmed = target?.trim();
  if (verb) {
    const word = verb[tense];
    const rest = trimmed ? stripLeadingVerb(trimmed, verb.stem) : "";
    return rest ? `${word} ${rest}` : word;
  }
  const humanised = name.replaceAll("_", " ");
  return trimmed ? `${humanised} ${trimmed}` : humanised;
}
