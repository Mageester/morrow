import type { WebConversationActivityEntry } from "@morrow/contracts";

/**
 * Chat-side curation of the execution activity projection.
 *
 * Morrow records a great deal of truthful execution telemetry, and the server
 * projection (`activity-projection.ts`) is deliberately complete: every route
 * decision, budget recalculation, classification and bookkeeping event that is
 * safe to show is in it. That completeness is right for Activity / Inspect and
 * for the raw ledger underneath it. It is wrong for a conversation.
 *
 * This module is the third view of the same data — the human one. It never
 * drops an event from the underlying record; it decides, per entry, whether the
 * event belongs in the reading column at all:
 *
 *   narration → the assistant's own words
 *   step      → work Morrow actually performed (tools, commands, edits)
 *   notable   → an exceptional transition a reader must not miss
 *   hidden    → routine internal bookkeeping; Activity / Inspect only
 *
 * Everything classified `hidden` here is still fetched, still rendered in the
 * Activity drawer, and still present in durable event storage. The difference
 * is presentation, not retention.
 */

export type ChatEntryRole = "narration" | "step" | "notable" | "hidden";

/** Tool kinds that represent work Morrow performed rather than a state change. */
const STEP_KINDS = new Set(["tool", "command", "file", "diff", "search", "process"]);

/**
 * Provider events that describe an exceptional transition rather than the
 * ordinary act of choosing a route. Matched on the projection's fixed summary
 * templates, which are the stable contract between the two layers — status
 * alone cannot separate "we classified this failure internally" (bookkeeping)
 * from "we fell back to another provider" (something the reader must see).
 */
const NOTABLE_PROVIDER_SUMMARIES = [
  "Route fallback used",
  "Provider or model changed",
  "Provider rate limit detected",
  "Provider returned no answer",
  "Requested reasoning not supported",
];

/** Context events that changed what Morrow can actually do with the window. */
const NOTABLE_CONTEXT_SUMMARIES = [
  "Context compacted",
  "Older context summarized",
  "Context approaching compaction threshold",
  "Context safety fallback applied",
  "Context compaction failed",
  "Context limit blocked this request",
];

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/**
 * Where a single activity entry belongs in the conversation.
 *
 * Deliberately a pure function of the entry: the same event always resolves the
 * same way, so the transcript cannot drift between renders and the rule set is
 * testable without a component tree.
 */
export function chatEntryRole(entry: WebConversationActivityEntry): ChatEntryRole {
  if (entry.kind === "narration") return "narration";
  if (STEP_KINDS.has(entry.kind)) return "step";

  switch (entry.kind) {
    case "assistant":
      // Morrow's own execution state ("Planning next step") is not model
      // reasoning and is not a chat message. The live status line reports it
      // while it is true, and it stays in Activity afterwards.
      return "hidden";
    case "plan":
    case "memory":
    case "evidence":
      // Bookkeeping: the durable record of it matters, the row does not.
      return "hidden";
    case "provider":
      return startsWithAny(entry.summary, NOTABLE_PROVIDER_SUMMARIES) ? "notable" : "hidden";
    case "context":
      return startsWithAny(entry.summary, NOTABLE_CONTEXT_SUMMARIES) ? "notable" : "hidden";
    case "recovery":
      // A recovery that failed, was required, or actually resumed the run is a
      // real event. "Recovery evaluated" and repeat advisories are telemetry
      // about a decision that changed nothing.
      if (entry.status === "failed") return "notable";
      return entry.summary === "Recovery required" || entry.summary === "Mission recovered and resumed"
        ? "notable"
        : "hidden";
    case "approval":
    case "checkpoint":
    case "validation":
      return "notable";
    case "system":
      // Terminal task states only reach the projection when they are not a
      // plain completion, so every one that arrives here is worth showing.
      return "notable";
    default:
      return "hidden";
  }
}

/** Read-only tools whose repetition is noise rather than information. */
const GROUPABLE_TOOLS = new Map<string, string>([
  ["read_file", "Files read"],
  ["list_files", "Directory listings"],
  ["read_artifact", "Artifacts read"],
  ["search_text", "Searches"],
  ["search_files", "Searches"],
  ["search_symbols", "Searches"],
  ["git_status", "Git inspections"],
  ["git_diff", "Git inspections"],
  ["git_log", "Git inspections"],
]);

/** Below this, showing each row individually is still calm and more useful. */
export const GROUP_THRESHOLD = 3;

export interface WorkStepSingle {
  type: "single";
  key: string;
  entry: WebConversationActivityEntry;
}

export interface WorkStepGroup {
  type: "group";
  key: string;
  /** "Files read" — the plural noun for the collapsed operations. */
  label: string;
  entries: readonly WebConversationActivityEntry[];
}

export type WorkStep = WorkStepSingle | WorkStepGroup;

export type TurnStatus = "idle" | "running" | "completed" | "failed";

export interface TurnWork {
  /** Ordered, with repetitive read-only operations collapsed. */
  steps: readonly WorkStep[];
  /** Exceptional transitions, de-duplicated against repeats. */
  notables: readonly WebConversationActivityEntry[];
  /** The assistant's own words, in the order they were streamed. */
  narrations: readonly WebConversationActivityEntry[];
  /** Every step entry, ungrouped — the count a reader recognises as "tools". */
  toolCount: number;
  /** Distinct files this turn actually changed. */
  filesChanged: number;
  /** Wall-clock span of the turn's recorded work; null when unknowable. */
  durationMs: number | null;
  status: TurnStatus;
  /** The step currently in flight, for the live status line. */
  runningEntry: WebConversationActivityEntry | null;
}

const EMPTY_TURN: TurnWork = {
  steps: [],
  notables: [],
  narrations: [],
  toolCount: 0,
  filesChanged: 0,
  durationMs: null,
  status: "idle",
  runningEntry: null,
};

/** Tools that write to the workspace, for the "N files changed" count. */
const MUTATING_TOOLS = new Set(["propose_patch", "create_file", "create_directory"]);

function groupSteps(steps: readonly WebConversationActivityEntry[]): WorkStep[] {
  // Count first, so the decision to collapse is made over the whole turn rather
  // than over whatever happens to be adjacent: eight reads split by one edit
  // are still eight reads.
  const counts = new Map<string, number>();
  for (const entry of steps) {
    const label = groupLabelFor(entry);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const result: WorkStep[] = [];
  const groupIndex = new Map<string, number>();
  for (const entry of steps) {
    const label = groupLabelFor(entry);
    if (!label || (counts.get(label) ?? 0) < GROUP_THRESHOLD) {
      result.push({ type: "single", key: entry.id, entry });
      continue;
    }
    const existing = groupIndex.get(label);
    if (existing === undefined) {
      groupIndex.set(label, result.length);
      result.push({ type: "group", key: `group:${label}:${entry.id}`, label, entries: [entry] });
      continue;
    }
    const group = result[existing] as WorkStepGroup;
    result[existing] = { ...group, entries: [...group.entries, entry] };
  }
  return result;
}

/**
 * The collapsed label for an entry, or null when it must stay on its own row.
 * A failure or an in-flight operation is never folded away — those are exactly
 * the rows a reader is looking for.
 */
function groupLabelFor(entry: WebConversationActivityEntry): string | null {
  if (entry.status !== "completed") return null;
  if (!entry.toolName) return null;
  return GROUPABLE_TOOLS.get(entry.toolName) ?? null;
}

/**
 * Drops a notable that repeats the one before it. The runtime can legitimately
 * emit the same transition twice (a rate limit hit on consecutive attempts);
 * saying so twice in the reading column adds nothing.
 */
function dedupeNotables(
  notables: readonly WebConversationActivityEntry[],
): WebConversationActivityEntry[] {
  const result: WebConversationActivityEntry[] = [];
  for (const entry of notables) {
    const previous = result.at(-1);
    if (previous && previous.summary === entry.summary && previous.detail === entry.detail) continue;
    result.push(entry);
  }
  return result;
}

function spanMs(entries: readonly WebConversationActivityEntry[]): number | null {
  if (entries.length === 0) return null;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const start = Date.parse(entry.createdAt);
    const end = Date.parse(entry.updatedAt);
    if (Number.isFinite(start)) earliest = Math.min(earliest, start);
    if (Number.isFinite(end)) latest = Math.max(latest, end);
  }
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) return null;
  const span = latest - earliest;
  return span >= 0 ? span : null;
}

/**
 * Projects one assistant turn's activity into the shape the conversation
 * renders. `streaming` is the message's own state, which is authoritative for
 * "is this turn still going" — an activity list can look finished a beat before
 * the message does.
 */
export function projectTurnWork(
  entries: readonly WebConversationActivityEntry[] | undefined,
  streaming = false,
): TurnWork {
  if (!entries || entries.length === 0) {
    return streaming ? { ...EMPTY_TURN, status: "running" } : EMPTY_TURN;
  }

  const steps: WebConversationActivityEntry[] = [];
  const notables: WebConversationActivityEntry[] = [];
  const narrations: WebConversationActivityEntry[] = [];
  const changedFiles = new Set<string>();
  let runningEntry: WebConversationActivityEntry | null = null;
  let failed = false;

  for (const entry of entries) {
    switch (chatEntryRole(entry)) {
      case "narration":
        narrations.push(entry);
        break;
      case "step":
        steps.push(entry);
        if (entry.status === "running") runningEntry = entry;
        if (entry.status === "failed") failed = true;
        if (entry.status === "completed" && entry.toolName && MUTATING_TOOLS.has(entry.toolName) && entry.target) {
          changedFiles.add(entry.target);
        }
        break;
      case "notable":
        notables.push(entry);
        if (entry.status === "failed") failed = true;
        break;
      case "hidden":
        break;
    }
  }

  const status: TurnStatus = streaming
    ? "running"
    : failed
      ? "failed"
      : steps.length > 0 || notables.length > 0
        ? "completed"
        : "idle";

  return {
    steps: groupSteps(steps),
    notables: dedupeNotables(notables),
    narrations,
    toolCount: steps.length,
    filesChanged: changedFiles.size,
    durationMs: spanMs(entries),
    status,
    runningEntry,
  };
}

/** "1m 24s" / "42s" / "820ms" — the shortest form that stays unambiguous. */
export function formatElapsed(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The headline for a turn's work summary. Wording follows the turn's real
 * state: nothing here claims completion for a run that failed, and an unknown
 * duration is omitted rather than rendered as zero.
 */
export function workSummaryLabel(work: TurnWork): string {
  const parts: string[] = [];
  const elapsed = formatElapsed(work.durationMs);
  if (work.status === "running") {
    parts.push("Working");
  } else if (work.status === "failed") {
    parts.push("Stopped on an error");
  } else {
    parts.push("Completed");
  }
  if (elapsed) parts.push(elapsed);
  if (work.toolCount > 0) parts.push(`${work.toolCount} tool${work.toolCount === 1 ? "" : "s"}`);
  if (work.filesChanged > 0) {
    parts.push(`${work.filesChanged} file${work.filesChanged === 1 ? "" : "s"} changed`);
  }
  return parts.join(" · ");
}
