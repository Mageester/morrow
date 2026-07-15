/**
 * The terminal state store: a pure reducer over `TerminalEvent`s.
 *
 * `reduce` performs no I/O and returns a new state. It is the single source of
 * truth for the screen; both the line renderer and the interactive renderer
 * fold the same events through it, so their content can never diverge. History
 * and activity are bounded so a long session cannot grow memory without limit.
 */
import type { ActivityKind, ApprovalSource, SessionMeta, TerminalEvent, UsageInfo } from "./events.js";
import type { ReasoningConfiguration } from "@morrow/contracts";
import { sanitizeTerminalText } from "../cli/output.js";

export type SessionStatus = "idle" | "streaming" | "completed" | "failed" | "cancelled" | "interrupted" | "budget-reached" | "stalled";

export interface ToolCard {
  id: string;
  name: string;
  purpose?: string;
  scope?: string;
  verification?: boolean;
  status: "running" | "completed" | "failed";
  startedAt: number;
  elapsedMs?: number;
  summary?: string;
  error?: string;
  approval?: ApprovalSource;
  outputRef?: string;
}

export interface ConversationEntry {
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  /** Present on assistant entries created via `assistant.turn_start`. Absent
   *  on entries reconstructed from a pre-turn-boundary (legacy) event stream. */
  turnId?: string;
  /** True only for the turn that produced no further tool calls — the
   *  user-facing canonical answer. Unset while streaming or for intermediate
   *  turns. */
  final?: boolean;
  /** The turn ended without completing normally (cancelled/errored mid-stream). */
  aborted?: boolean;
}

export interface ActivityEntry {
  kind: ActivityKind;
  detail?: string;
  count?: number;
  at: number;
}

/**
 * One recoverable problem and its outcome. Identical failures (same tool +
 * message) group into a single entry with a count, so "patch mismatch ×3"
 * renders as one line instead of three red walls.
 */
export interface RecoveryEntry {
  tool: string;
  message: string;
  count: number;
  status: "failed" | "retrying" | "recovered";
  strategy?: string;
  /** Active tool call that produced the latest signal, used to coalesce the
   * recovery-specific event and the generic tool.failed event for one call. */
  toolCallId?: string;
  /** File this recovery is about, when known (patch/file-tool failures).
   *  Scopes resolution so a success on an unrelated file never marks this
   *  entry recovered — absent for tool-generic failures (e.g. a command). */
  file?: string;
  at: number;
}

export interface PatchEntry {
  files: string[];
  additions?: number;
  deletions?: number;
  explanation?: string;
  approval?: ApprovalSource;
  applied: boolean;
}

export interface RoutingInfo {
  provider: string;
  model: string;
  preset: string;
  fallback: boolean;
  overridden: boolean;
  privacy: string;
  reasoning?: ReasoningConfiguration | undefined;
}

export interface NoticeEntry {
  level: "info" | "warn" | "error";
  text: string;
}

export interface PlanEntry {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
}

export interface TerminalState {
  meta?: SessionMeta;
  routing?: RoutingInfo;
  conversation: ConversationEntry[];
  activity: ActivityEntry[];
  tools: ToolCard[];
  patches: PatchEntry[];
  plan: PlanEntry[];
  notices: NoticeEntry[];
  status: SessionStatus;
  lastError?: string;
  usage?: UsageInfo;
  /** Usage emitted by the task currently represented in the live frame. The
   * session aggregate above remains cumulative for /stats and cost reporting. */
  activeUsage?: UsageInfo;
  git?: import("./events.js").GitStateInfo;
  contextUsage?: import("./events.js").ContextUsageInfo;
  progressStage?: import("./events.js").ProgressStage;
  progressDetail?: string;
  processes: import("./events.js").ProcessInfo[];
  worktrees: import("./events.js").WorktreeInfo[];
  agents: import("./events.js").AgentInfo[];
  integrations: import("./events.js").IntegrationInfo[];
  recoverySuggestions: string[];
  recoveries: RecoveryEntry[];
  /** Ordinary text typed while the current task streams, oldest first. Never
   *  a second task-message channel — each entry is sent as a normal
   *  `user.message` (via `redirect.sent`) once the running task ends. */
  queuedMessages: string[];
}

export const MAX_CONVERSATION = 200;
export const MAX_ACTIVITY = 80;
export const MAX_NOTICES = 6;
export const MAX_QUEUED = 5;

export function initialState(): TerminalState {
  return { conversation: [], activity: [], tools: [], patches: [], plan: [], notices: [], status: "idle", processes: [], worktrees: [], agents: [], integrations: [], recoverySuggestions: [], recoveries: [], queuedMessages: [] };
}

function bounded<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

/** The still-open assistant entry for `turnId`, searched from the end since
 *  it is always at or near the tail. Never matches a closed turn — a delta
 *  or end for an already-finished turn is a dropped/duplicated event, not a
 *  continuation of it. */
function findActiveTurnIndex(conversation: ConversationEntry[], turnId: string): number {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const entry = conversation[i]!;
    if (entry.role !== "assistant") continue;
    if (entry.turnId === turnId && entry.streaming) return i;
    if (entry.turnId === turnId) return -1; // matched but already closed
  }
  return -1;
}

/** Fold one event into a new state. Pure: no mutation of `state`, no I/O. */
export function reduce(state: TerminalState, event: TerminalEvent, now: () => number = Date.now): TerminalState {
  if (isTerminalStatus(state.status) && isTerminalTaskEvent(event.type)) return state;
  switch (event.type) {
    case "session.started":
      return {
        ...state,
        meta: {
          ...event.meta,
          greeting: sanitizeTerminalText(event.meta.greeting),
          projectName: sanitizeTerminalText(event.meta.projectName),
          workspacePath: sanitizeTerminalText(event.meta.workspacePath),
          branch: sanitizeTerminalText(event.meta.branch),
          provider: sanitizeTerminalText(event.meta.provider),
          model: sanitizeTerminalText(event.meta.model),
          privacy: sanitizeTerminalText(event.meta.privacy),
          mode: sanitizeTerminalText(event.meta.mode),
          ...(event.meta.name !== undefined ? { name: sanitizeTerminalText(event.meta.name) } : {}),
        },
      };

    case "plan.snapshot":
      return { ...state, plan: event.steps.map((step) => ({ ...step, title: sanitizeTerminalText(step.title) })) };

    case "routing":
      return {
        ...state,
        routing: {
          provider: sanitizeTerminalText(event.provider),
          model: sanitizeTerminalText(event.model),
          preset: sanitizeTerminalText(event.preset),
          fallback: event.fallback,
          overridden: event.overridden,
          privacy: event.privacy,
          reasoning: event.reasoning,
        },
      };

    case "user.message": {
      // A submitted message starts a new backend task. Keep the session
      // transcript and cumulative usage, but never let the previous task's
      // tools, patches, recovery story, plan, or terminal error leak into the
      // new task's live status and completion card.
      const {
        lastError: _lastError,
        progressStage: _progressStage,
        progressDetail: _progressDetail,
        routing: _routing,
        activeUsage: _activeUsage,
        ...sessionState
      } = state;
      return {
        ...sessionState,
        conversation: bounded(
          [...state.conversation, { role: "user", text: sanitizeTerminalText(event.text), streaming: false }],
          MAX_CONVERSATION
        ),
        activity: [],
        tools: [],
        patches: [],
        plan: [],
        recoveries: [],
        recoverySuggestions: [],
        status: "streaming",
      };
    }

    case "assistant.turn_start": {
      // Defensively close a still-open turn first — a well-formed stream always
      // sends turn_end before the next turn_start, but a dropped event must
      // never let two turns' deltas merge into one message.
      let conversation = state.conversation;
      const prior = conversation[conversation.length - 1];
      if (prior && prior.role === "assistant" && prior.streaming) {
        conversation = [...conversation];
        conversation[conversation.length - 1] = { ...prior, streaming: false, aborted: true };
      }
      return {
        ...state,
        conversation: bounded(
          [...conversation, { role: "assistant", text: "", streaming: true, turnId: event.turnId }],
          MAX_CONVERSATION
        ),
        status: "streaming",
      };
    }

    case "assistant.delta": {
      const idx = findActiveTurnIndex(state.conversation, event.turnId);
      if (idx >= 0) {
        const updated = [...state.conversation];
        const entry = updated[idx]!;
        updated[idx] = { ...entry, text: entry.text + sanitizeTerminalText(event.text) };
        return { ...state, conversation: updated, status: "streaming" };
      }
      // `"legacy"` is the adapter's explicit sentinel for "this backend
      // predates turn boundaries" (see task-event-adapter.ts) — auto-opening
      // a turn for it is a recognized fallback, not a guess. Any other
      // unmatched turnId is a real mismatch and is dropped, not merged.
      if (event.turnId === "legacy") {
        return {
          ...state,
          conversation: bounded(
            [...state.conversation, { role: "assistant", text: sanitizeTerminalText(event.text), streaming: true, turnId: "legacy" }],
            MAX_CONVERSATION
          ),
          status: "streaming",
        };
      }
      return {
        ...state,
        notices: bounded(
          [...state.notices, { level: "warn", text: `Discarded assistant text for an unrecognized turn (${event.turnId}).` }],
          MAX_NOTICES
        ),
      };
    }

    case "assistant.turn_end": {
      const idx = findActiveTurnIndex(state.conversation, event.turnId);
      if (idx < 0) return state;
      const updated = [...state.conversation];
      updated[idx] = {
        ...updated[idx]!,
        streaming: false,
        final: event.final,
        ...(event.aborted ? { aborted: true } : {}),
      };
      return { ...state, conversation: updated };
    }

    case "assistant.end": {
      // Generic safety net (no turnId): close whatever is still open. Only
      // ever needed if a turn_end was dropped or the stream predates turns.
      const last = state.conversation[state.conversation.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        const updated = [...state.conversation];
        updated[updated.length - 1] = { ...last, streaming: false, final: last.final ?? true };
        return { ...state, conversation: updated };
      }
      return state;
    }

    case "activity": {
      const entry: ActivityEntry = {
        kind: event.kind,
        at: now(),
        ...(event.detail !== undefined ? { detail: sanitizeTerminalText(event.detail) } : {}),
        ...(event.count !== undefined ? { count: event.count } : {}),
      };
      return { ...state, activity: bounded([...state.activity, entry], MAX_ACTIVITY) };
    }

    case "tool.start": {
      const card: ToolCard = {
        id: event.id,
        name: sanitizeTerminalText(event.name),
        status: "running",
        startedAt: now(),
        ...(event.purpose !== undefined ? { purpose: sanitizeTerminalText(event.purpose) } : {}),
        ...(event.scope !== undefined ? { scope: sanitizeTerminalText(event.scope) } : {}),
        ...(event.verification !== undefined ? { verification: event.verification } : {}),
      };
      return { ...state, tools: [...state.tools, card] };
    }

    case "tool.end": {
      const idx = state.tools.findIndex((t) => t.id === event.id && t.status === "running");
      if (idx < 0) return state;
      const existing = state.tools[idx]!;
      const elapsed = event.elapsedMs ?? Math.max(0, now() - existing.startedAt);
      const updatedCard: ToolCard = {
        ...existing,
        status: event.status,
        elapsedMs: elapsed,
        ...(event.summary !== undefined ? { summary: sanitizeTerminalText(event.summary) } : {}),
        ...(event.error !== undefined ? { error: sanitizeTerminalText(event.error) } : {}),
        ...(event.approval !== undefined ? { approval: event.approval } : {}),
        ...(event.outputRef !== undefined ? { outputRef: event.outputRef } : {}),
      };
      const tools = [...state.tools];
      tools[idx] = updatedCard;
      // A successful retry resolves the latest open problem for that tool. It
      // must not retroactively mark unrelated earlier failures as recovered.
      const recoveries = [...state.recoveries];
      if (event.status === "completed") {
        for (let recoveryIndex = recoveries.length - 1; recoveryIndex >= 0; recoveryIndex -= 1) {
          const recovery = recoveries[recoveryIndex]!;
          if (recovery.tool !== existing.name || recovery.status === "recovered") continue;
          recoveries[recoveryIndex] = { ...recovery, status: "recovered" };
          break;
        }
      }
      return { ...state, tools, recoveries };
    }

    case "recovery.problem": {
      const tool = sanitizeTerminalText(event.tool);
      const message = sanitizeTerminalText(event.message);
      const file = event.file !== undefined ? sanitizeTerminalText(event.file) : undefined;
      const activeToolCallId = [...state.tools].reverse().find((entry) => entry.name === tool && entry.status === "running")?.id;
      // Recovery feedback and the generic tool.failed signal describe the same
      // failed call. Keep the richer first story instead of rendering both.
      if (activeToolCallId) {
        const sameCall = state.recoveries.findIndex((recovery) => recovery.toolCallId === activeToolCallId && recovery.status !== "recovered");
        if (sameCall >= 0) return state;
      }
      // Group identical failures across distinct attempts into one counted entry.
      const idx = state.recoveries.findIndex((recovery) => recovery.tool === tool && recovery.message === message && recovery.file === file && recovery.status !== "recovered");
      if (idx >= 0) {
        const recoveries = [...state.recoveries];
        recoveries[idx] = {
          ...recoveries[idx]!,
          count: recoveries[idx]!.count + 1,
          at: now(),
          ...(activeToolCallId ? { toolCallId: activeToolCallId } : {}),
        };
        return { ...state, recoveries };
      }
      return {
        ...state,
        recoveries: bounded([
          ...state.recoveries,
          {
            tool,
            message,
            count: 1,
            status: "failed" as const,
            at: now(),
            ...(activeToolCallId ? { toolCallId: activeToolCallId } : {}),
            ...(file !== undefined ? { file } : {}),
          },
        ], MAX_ACTIVITY),
      };
    }

    case "recovery.strategy": {
      const tool = event.tool === undefined ? undefined : sanitizeTerminalText(event.tool);
      const strategy = sanitizeTerminalText(event.strategy);
      const file = event.file !== undefined ? sanitizeTerminalText(event.file) : undefined;
      // Mark the most recent open problem (for this tool/file) as retrying.
      // File matching is strict (both sides equal, including both undefined)
      // — the same rule `recovery.problem` groups by — so a file-scoped
      // strategy event can never attach itself to, and thereby hijack, an
      // unrelated file-less or different-file entry for the same tool.
      const recoveries = [...state.recoveries];
      for (let i = recoveries.length - 1; i >= 0; i--) {
        const entry = recoveries[i]!;
        if (entry.status === "recovered") continue;
        if (tool && entry.tool !== tool) continue;
        if (entry.file !== file) continue;
        recoveries[i] = { ...entry, status: "retrying", strategy };
        return { ...state, recoveries };
      }
      // No matching problem — record the switch itself so it is never invisible.
      return {
        ...state,
        recoveries: bounded([...recoveries, { tool: tool ?? "agent", message: strategy, count: 1, status: "retrying" as const, strategy, at: now(), ...(file !== undefined ? { file } : {}) }], MAX_ACTIVITY),
      };
    }

    case "patch.proposed": {
      const patch: PatchEntry = {
        files: event.files.map(sanitizeTerminalText),
        applied: false,
        ...(event.additions !== undefined ? { additions: event.additions } : {}),
        ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
        ...(event.explanation !== undefined ? { explanation: sanitizeTerminalText(event.explanation) } : {}),
        ...(event.approval !== undefined ? { approval: event.approval } : {}),
      };
      return { ...state, patches: [...state.patches, patch] };
    }

    case "patch.applied": {
      const files = event.files.map(sanitizeTerminalText);
      const matchesFile = (r: RecoveryEntry) => r.file !== undefined && files.includes(r.file);
      // Any recovery with no known file (a generic tool.failed signal, never
      // narrowed to a path) is inherently ambiguous — it is only safe to
      // resolve it when NO file-scoped recovery is open anywhere in the task,
      // not merely none for this write's files, since an unrelated file's
      // still-open, *identified* failure must never be masked by this one
      // succeeding. A file-scoped recovery is resolved only when it names one
      // of these files.
      const anyFileScopedOpen = state.recoveries.some((r) => r.status !== "recovered" && r.file !== undefined);
      const willResolve = (r: RecoveryEntry) =>
        r.status !== "recovered" && isPatchTool(r.tool) && (r.file !== undefined ? matchesFile(r) : !anyFileScopedOpen);
      const recoveries = state.recoveries.some(willResolve)
        ? state.recoveries.map((r) => (willResolve(r) ? { ...r, status: "recovered" as const } : r))
        : state.recoveries;
      // Coalesce only into a still-pending (unapplied) entry for these exact
      // files — a real `patch.proposed` placeholder for this specific write.
      // An *already-applied* entry is a distinct, completed edit and must
      // never absorb a later success, even one that happens to resolve an
      // open recovery for the same file: file-scoping on the recovery only
      // establishes which file failed, not which write attempt is retrying
      // it, so it cannot be used to pick a target among several prior
      // entries for that file. Without a live `patch.proposed` upstream
      // (currently unemitted — see task-event-adapter.ts), a fail → retry →
      // success cycle naturally finds no unapplied entry yet and appends a
      // single new one, which is exactly "one action"; a genuinely separate
      // later edit likewise appends its own new entry instead of merging
      // into the earlier, already-applied one.
      const idx = [...state.patches].reverse().findIndex((p) => !p.applied && sameFiles(p.files, files));
      if (idx >= 0) {
        const realIdx = state.patches.length - 1 - idx;
        const patches = [...state.patches];
        const target = patches[realIdx]!;
        patches[realIdx] = {
          ...target,
          applied: true,
          ...(event.approval !== undefined ? { approval: event.approval } : {}),
        };
        return { ...state, patches, recoveries };
      }
      return {
        ...state,
        recoveries,
        patches: [
          ...state.patches,
          { files, applied: true, ...(event.approval !== undefined ? { approval: event.approval } : {}) },
        ],
      };
    }

    case "approval.auto":
      // Approval provenance belongs to the durable task record and `/output`,
      // not the activity feed: Build Auto can emit many of these without any
      // corresponding user-visible work phase.
      return state;

    case "notice": {
      const noticeText = sanitizeTerminalText(event.text);
      return {
        ...state,
        notices: bounded([...state.notices, { level: event.level, text: noticeText }], MAX_NOTICES),
        ...(event.level === "error" ? { lastError: noticeText } : {}),
      };
    }

    case "usage.reported": {
      const previous = state.usage;
      const provider = sanitizeTerminalText(event.provider);
      const model = sanitizeTerminalText(event.model);
      const providerKey = `${provider}/${model}`;
      const providerChanges = previous
        ? previous.providerChanges.includes(providerKey)
          ? previous.providerChanges
          : [...previous.providerChanges, providerKey]
        : [providerKey];
      // inputTokens is the TOTAL input (fresh + cached combined) as reported
      // by the provider — always a complete, exact sum regardless of
      // whether any individual response's cache breakdown is known.
      const inputTokens = (previous?.inputTokens ?? 0) + event.inputTokens;
      const outputTokens = (previous?.outputTokens ?? 0) + event.outputTokens;
      // Known cached-token subtotal: sums only the responses that reported
      // one. This is the exact cumulative cached total ONLY while
      // cacheBreakdownComplete stays true; the moment one response doesn't
      // report a breakdown, it becomes a partial lower bound and must never
      // be presented as the whole (never coerced to 0 for "didn't report,"
      // and never silently upgraded back to "complete" once broken).
      const cacheBreakdownComplete = (previous?.cacheBreakdownComplete ?? true) && event.cachedInputTokens !== undefined;
      const cachedInputTokens =
        event.cachedInputTokens === undefined
          ? (previous?.cachedInputTokens ?? null)
          : (previous?.cachedInputTokens ?? 0) + event.cachedInputTokens;
      const estimatedCostUsd =
        event.estimatedCostUsd === undefined || event.estimatedCostUsd === null || previous?.estimatedCostUsd === null
          ? null
          : (previous?.estimatedCostUsd ?? 0) + event.estimatedCostUsd;
      return {
        ...state,
        usage: {
          provider,
          model,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cachedInputTokens,
          cacheBreakdownComplete,
          estimatedCostUsd,
          calls: (previous?.calls ?? 0) + 1,
          providerChanges,
        },
        activeUsage: {
          provider,
          model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.inputTokens + event.outputTokens,
          cachedInputTokens: event.cachedInputTokens ?? null,
          cacheBreakdownComplete: event.cachedInputTokens !== undefined,
          estimatedCostUsd: event.estimatedCostUsd ?? null,
          calls: 1,
          providerChanges: [providerKey],
          reasoning: event.reasoning,
        },
      };
    }

    case "task.completed":
      return { ...state, status: "completed" };

    case "task.failed":
      return { ...state, status: "failed", lastError: sanitizeTerminalText(event.message) };

    case "task.cancelled":
      return { ...state, status: "cancelled" };

    case "task.interrupted":
      return { ...state, status: "interrupted" };
    case "task.budget_reached":
      return { ...state, status: "budget-reached", lastError: sanitizeTerminalText(event.message) };
    case "task.stalled":
      return { ...state, status: "stalled", lastError: sanitizeTerminalText(event.message) };

    // ── Extended presentation events ──────────────────────────────────────
    case "git.state":
      return { ...state, git: { ...event.git, branch: sanitizeTerminalText(event.git.branch) } };

    case "context.usage": {
      const merged = { ...state.contextUsage, ...event.usage };
      const limit = merged.contextLimitTokens ?? (merged.contextWindowSource === "fallback" ? null : merged.maxTokens);
      const percent = limit && limit > 0 ? Math.round((merged.usedTokens / limit) * 100) : null;
      return { ...state, contextUsage: { ...merged, contextLimitTokens: limit ?? null, percent } };
    }

    case "progress.stage":
      return {
        ...state,
        progressStage: event.stage,
        ...(event.detail !== undefined ? { progressDetail: sanitizeTerminalText(event.detail) } : {}),
      };

    case "process.update":
      return { ...state, processes: event.processes };

    case "worktree.update":
      return { ...state, worktrees: event.worktrees };

    case "agent.update":
      return { ...state, agents: event.agents };

    case "integration.update":
      return { ...state, integrations: event.integrations };

    case "recovery.suggestion":
      return {
        ...state,
        recoverySuggestions: bounded([...state.recoverySuggestions, sanitizeTerminalText(event.text)], MAX_NOTICES),
      };

    case "redirect.queued":
      return {
        ...state,
        queuedMessages: bounded([...state.queuedMessages, sanitizeTerminalText(event.text)], MAX_QUEUED),
      };

    case "redirect.sent":
      return state.queuedMessages.length === 0 ? state : { ...state, queuedMessages: state.queuedMessages.slice(1) };

    default: {
      // Exhaustiveness guard: a new event type must be handled here.
      const _never: never = event;
      return state;
    }
  }
}

function isTerminalStatus(status: SessionStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted", "budget-reached", "stalled"].includes(status);
}

function isTerminalTaskEvent(type: TerminalEvent["type"]): boolean {
  return ["task.completed", "task.failed", "task.cancelled", "task.interrupted", "task.budget_reached", "task.stalled"].includes(type);
}

/** Tools whose failures a successful patch application resolves. */
function isPatchTool(tool: string): boolean {
  return tool === "propose_patch" || tool === "apply_patch" || tool === "create_file" || tool === "edit_file";
}

function sameFiles(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}
