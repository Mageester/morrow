import type { ToolCallRecord } from "../repositories/conversations.js";

/**
 * Cross-turn working memory for a chat conversation.
 *
 * A single agent run sees every tool call it makes. The next user turn in the
 * same conversation does not: prior turns are replayed to the model as plain
 * user/assistant text, so every file read, command, search, and patch from
 * earlier turns is gone. The model then re-explores the project from nothing
 * on every follow-up — the single largest source of wasted turns and duplicated
 * reads in a long chat.
 *
 * This module rebuilds a bounded digest of that work from the durable tool-call
 * records Morrow already persists. It is deliberately *derived*, never a second
 * stored copy: whatever the tool-call log says is what the model is told, so
 * deleting a conversation or compacting it removes the memory with it, and the
 * digest can never drift from the audit record.
 *
 * Privacy boundary: file *contents* are never included — only paths, byte
 * sizes, command lines with exit codes, result counts, and bounded error text,
 * all taken from records that are already redacted on read. The digest travels
 * to exactly one place, the same provider request the rest of the conversation
 * already travels to.
 */

/** Ordered most-valuable-first: what survives truncation is what matters most. */
const CATEGORY_ORDER = ["changed", "ran", "read", "explored", "browsed"] as const;
type Category = (typeof CATEGORY_ORDER)[number];

const CATEGORY_TITLES: Record<Category, string> = {
  changed: "Files you already created or edited",
  ran: "Commands you already ran",
  read: "Files you already read",
  explored: "Searches and listings you already did",
  browsed: "Pages you already opened",
};

export interface WorkingSetTurn {
  /** Prior task in this conversation, oldest first. */
  taskId: string;
  toolCalls: ToolCallRecord[];
}

export interface WorkingSetOptions {
  /** Hard cap on the rendered digest, in characters. */
  maxChars?: number;
  /** Most recent prior turns considered. */
  maxTurns?: number;
  /** Distinct entries retained per category. */
  maxEntriesPerCategory?: number;
}

export const WORKING_SET_DEFAULTS: Required<WorkingSetOptions> = {
  maxChars: 2_400,
  maxTurns: 12,
  maxEntriesPerCategory: 20,
};

const MAX_TARGET_CHARS = 120;
const MAX_ERROR_CHARS = 100;

function clip(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function parseArgs(argsJson: string | null | undefined): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Unified-diff headers are the only place a patch names its files. */
function patchedFiles(patch: string | undefined): string[] {
  if (!patch) return [];
  const files = [...patch.matchAll(/^\+\+\+\s+(?:b\/)?([^\r\n]+)$/gm)]
    .map((match) => match[1]!)
    .filter((path) => path !== "/dev/null");
  return [...new Set(files)];
}

function commandLine(args: Record<string, unknown>): string | undefined {
  const executable = text(args.executable);
  if (!executable) return undefined;
  const argv = Array.isArray(args.args) ? args.args.filter((item): item is string => typeof item === "string") : [];
  return argv.length > 0 ? `${executable} ${argv.join(" ")}` : executable;
}

function exitCode(resultJson: string | null | undefined): number | undefined {
  if (!resultJson) return undefined;
  try {
    const parsed = JSON.parse(resultJson) as { exitCode?: unknown };
    return typeof parsed.exitCode === "number" ? parsed.exitCode : undefined;
  } catch {
    return undefined;
  }
}

/** Result shapes differ per tool; report a count only when one is unambiguous. */
function resultCount(resultJson: string | null | undefined): number | undefined {
  if (!resultJson) return undefined;
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;
    for (const key of ["matches", "results", "entries", "files", "symbols", "skills"]) {
      const value = parsed[key];
      if (Array.isArray(value)) return value.length;
    }
    const total = parsed.totalMatches ?? parsed.count;
    return typeof total === "number" ? total : undefined;
  } catch {
    return undefined;
  }
}

function byteSize(resultJson: string | null | undefined): number | undefined {
  return typeof resultJson === "string" ? Buffer.byteLength(resultJson, "utf8") : undefined;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** Strip an origin's credentials/query before a URL is described back. */
function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

interface Entry {
  category: Category;
  /** Dedupe identity: a repeat of the same work replaces the older outcome. */
  key: string;
  detail: string;
}

function entriesForCall(call: ToolCallRecord): Entry[] {
  if (call.status !== "completed" && call.status !== "failed") return [];
  const args = parseArgs(call.argsJson);
  const failed = call.status === "failed";
  const failure = failed
    ? ` — FAILED: ${clip(call.errorMessage ?? call.errorType ?? "no reason recorded", MAX_ERROR_CHARS)}`
    : "";

  const single = (category: Category, key: string, detail: string): Entry[] => [
    { category, key: `${category}:${key}`, detail: `${detail}${failure}` },
  ];

  switch (call.toolName) {
    case "read_file": {
      const path = text(args.path);
      if (!path) return [];
      const size = failed ? undefined : byteSize(call.resultJson);
      return single("read", path, `${clip(path, MAX_TARGET_CHARS)}${size === undefined ? "" : ` (${formatBytes(size)})`}`);
    }
    case "create_file": {
      const path = text(args.path);
      return path ? single("changed", path, `created ${clip(path, MAX_TARGET_CHARS)}`) : [];
    }
    case "create_directory": {
      const path = text(args.path);
      return path ? single("changed", path, `created directory ${clip(path, MAX_TARGET_CHARS)}`) : [];
    }
    case "propose_patch": {
      const files = patchedFiles(text(args.patch));
      if (files.length === 0) return single("changed", "patch", `patched (files not recorded)`);
      return files.map((file) => ({
        category: "changed" as const,
        key: `changed:${file}`,
        detail: `patched ${clip(file, MAX_TARGET_CHARS)}${failure}`,
      }));
    }
    case "run_command": {
      const line = commandLine(args);
      if (!line) return [];
      // The exit code is the signal that stops a command being re-run blind,
      // so it outranks the generic failure text whenever it is known.
      const code = exitCode(call.resultJson);
      const outcome = code !== undefined ? ` → exit ${code}` : failed ? failure : "";
      return [{ category: "ran", key: `ran:${line}`, detail: `\`${clip(line, MAX_TARGET_CHARS)}\`${outcome}` }];
    }
    case "search_text":
    case "search_files":
    case "search_symbols": {
      const query = text(args.query) ?? text(args.pattern) ?? text(args.name);
      if (!query) return [];
      const count = failed ? undefined : resultCount(call.resultJson);
      const verb = call.toolName === "search_files" ? "matched files" : call.toolName === "search_symbols" ? "searched symbols" : "searched text";
      return single("explored", `${call.toolName}:${query}`, `${verb} "${clip(query, MAX_TARGET_CHARS)}"${count === undefined ? "" : ` → ${count} result${count === 1 ? "" : "s"}`}`);
    }
    case "list_files": {
      const path = text(args.path) ?? ".";
      const count = failed ? undefined : resultCount(call.resultJson);
      return single("explored", `list:${path}`, `listed ${clip(path, MAX_TARGET_CHARS)}${count === undefined ? "" : ` (${count} entries)`}`);
    }
    case "inspect_workspace":
      return single("explored", "inspect_workspace", "inspected the workspace root");
    case "git_status":
    case "git_diff":
    case "git_log":
      return single("explored", call.toolName, `ran ${call.toolName.replace("_", " ")}`);
    case "load_skill":
    case "find_skill": {
      const skill = text(args.skill_id) ?? text(args.skillId) ?? text(args.query);
      return skill ? single("explored", `${call.toolName}:${skill}`, `${call.toolName === "load_skill" ? "loaded skill" : "searched skills for"} ${clip(skill, MAX_TARGET_CHARS)}`) : [];
    }
    case "browser_open": {
      const url = safeUrl(text(args.url));
      return url ? single("browsed", url, `opened ${clip(url, MAX_TARGET_CHARS)}`) : [];
    }
    default:
      return [];
  }
}

export interface ConversationWorkingSet {
  /** Rendered digest, or null when there is nothing worth carrying forward. */
  content: string | null;
  entryCount: number;
  truncated: boolean;
}

/**
 * Build a bounded digest of the work already done in earlier turns of this
 * conversation. `turns` must be ordered oldest-first and must already be
 * scoped to the same conversation, project, and worktree as the current task.
 */
export function buildConversationWorkingSet(turns: WorkingSetTurn[], options: WorkingSetOptions = {}): ConversationWorkingSet {
  const { maxChars, maxTurns, maxEntriesPerCategory } = { ...WORKING_SET_DEFAULTS, ...options };
  const considered = turns.slice(Math.max(0, turns.length - maxTurns));

  // A later repeat of identical work replaces the earlier record, so the model
  // is told the most recent outcome (a command that now passes is not still
  // reported as failing).
  const byKey = new Map<string, Entry>();
  for (const turn of considered) {
    for (const call of turn.toolCalls) {
      for (const entry of entriesForCall(call)) byKey.set(entry.key, entry);
    }
  }
  if (byKey.size === 0) return { content: null, entryCount: 0, truncated: false };

  const grouped = new Map<Category, string[]>();
  for (const entry of byKey.values()) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry.detail);
    grouped.set(entry.category, list);
  }

  let truncated = false;
  const sections: string[] = [];
  let used = 0;
  let entryCount = 0;
  const header =
    "Work you already completed earlier in this conversation (durable record of your own tool calls; the observations themselves are no longer in context). Do not repeat this exploration or re-derive these facts. Re-read a file only when you need its exact current contents, and prefer the paths below over searching for them again.";

  for (const category of CATEGORY_ORDER) {
    const all = grouped.get(category);
    if (!all || all.length === 0) continue;
    // Keep the most recent entries when a category overflows its own cap.
    const kept = all.slice(Math.max(0, all.length - maxEntriesPerCategory));
    if (kept.length < all.length) truncated = true;
    const lines: string[] = [];
    for (const detail of kept) {
      const line = `- ${detail}`;
      if (used + line.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += line.length + 1;
      entryCount += 1;
    }
    if (lines.length === 0) continue;
    sections.push(`${CATEGORY_TITLES[category]}:\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return { content: null, entryCount: 0, truncated: true };
  const suffix = truncated ? "\n(Older entries were dropped to stay within the context budget.)" : "";
  return { content: `${header}\n\n${sections.join("\n\n")}${suffix}`, entryCount, truncated };
}
