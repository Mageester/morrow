/**
 * The terminal state store: a pure reducer over `TerminalEvent`s.
 *
 * `reduce` performs no I/O and returns a new state. It is the single source of
 * truth for the screen; both the line renderer and the interactive renderer
 * fold the same events through it, so their content can never diverge. History
 * and activity are bounded so a long session cannot grow memory without limit.
 */
import type { ActivityKind, ApprovalSource, SessionMeta, TerminalEvent, UsageInfo } from "./events.js";

export type SessionStatus = "idle" | "streaming" | "completed" | "failed" | "cancelled" | "interrupted" | "budget-reached" | "stalled";

export interface ToolCard {
  id: string;
  name: string;
  purpose?: string;
  scope?: string;
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
}

export interface ActivityEntry {
  kind: ActivityKind;
  detail?: string;
  count?: number;
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
  git?: import("./events.js").GitStateInfo;
  contextUsage?: import("./events.js").ContextUsageInfo;
  progressStage?: import("./events.js").ProgressStage;
  progressDetail?: string;
  processes: import("./events.js").ProcessInfo[];
  worktrees: import("./events.js").WorktreeInfo[];
  agents: import("./events.js").AgentInfo[];
  integrations: import("./events.js").IntegrationInfo[];
  recoverySuggestions: string[];
}

export const MAX_CONVERSATION = 200;
export const MAX_ACTIVITY = 80;
export const MAX_NOTICES = 6;

export function initialState(): TerminalState {
  return { conversation: [], activity: [], tools: [], patches: [], plan: [], notices: [], status: "idle", processes: [], worktrees: [], agents: [], integrations: [], recoverySuggestions: [] };
}

function bounded<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

/** Fold one event into a new state. Pure: no mutation of `state`, no I/O. */
export function reduce(state: TerminalState, event: TerminalEvent, now: () => number = Date.now): TerminalState {
  if (isTerminalStatus(state.status) && isTerminalTaskEvent(event.type)) return state;
  switch (event.type) {
    case "session.started":
      return { ...state, meta: event.meta };

    case "plan.snapshot":
      return { ...state, plan: event.steps };

    case "routing":
      return {
        ...state,
        routing: {
          provider: event.provider,
          model: event.model,
          preset: event.preset,
          fallback: event.fallback,
          overridden: event.overridden,
          privacy: event.privacy,
        },
      };

    case "user.message":
      return {
        ...state,
        conversation: bounded(
          [...state.conversation, { role: "user", text: event.text, streaming: false }],
          MAX_CONVERSATION
        ),
        status: "streaming",
      };

    case "assistant.delta": {
      const last = state.conversation[state.conversation.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        const updated = [...state.conversation];
        updated[updated.length - 1] = { ...last, text: last.text + event.text };
        return { ...state, conversation: updated, status: "streaming" };
      }
      return {
        ...state,
        conversation: bounded(
          [...state.conversation, { role: "assistant", text: event.text, streaming: true }],
          MAX_CONVERSATION
        ),
        status: "streaming",
      };
    }

    case "assistant.end": {
      const last = state.conversation[state.conversation.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        const updated = [...state.conversation];
        updated[updated.length - 1] = { ...last, streaming: false };
        return { ...state, conversation: updated };
      }
      return state;
    }

    case "activity": {
      const entry: ActivityEntry = {
        kind: event.kind,
        at: now(),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        ...(event.count !== undefined ? { count: event.count } : {}),
      };
      return { ...state, activity: bounded([...state.activity, entry], MAX_ACTIVITY) };
    }

    case "tool.start": {
      const card: ToolCard = {
        id: event.id,
        name: event.name,
        status: "running",
        startedAt: now(),
        ...(event.purpose !== undefined ? { purpose: event.purpose } : {}),
        ...(event.scope !== undefined ? { scope: event.scope } : {}),
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
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.approval !== undefined ? { approval: event.approval } : {}),
        ...(event.outputRef !== undefined ? { outputRef: event.outputRef } : {}),
      };
      const tools = [...state.tools];
      tools[idx] = updatedCard;
      return { ...state, tools };
    }

    case "patch.proposed": {
      const patch: PatchEntry = {
        files: event.files,
        applied: false,
        ...(event.additions !== undefined ? { additions: event.additions } : {}),
        ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
        ...(event.explanation !== undefined ? { explanation: event.explanation } : {}),
        ...(event.approval !== undefined ? { approval: event.approval } : {}),
      };
      return { ...state, patches: [...state.patches, patch] };
    }

    case "patch.applied": {
      // Mark the most recent matching proposed patch as applied, else append.
      const idx = [...state.patches].reverse().findIndex((p) => !p.applied && sameFiles(p.files, event.files));
      if (idx >= 0) {
        const realIdx = state.patches.length - 1 - idx;
        const patches = [...state.patches];
        const target = patches[realIdx]!;
        patches[realIdx] = {
          ...target,
          applied: true,
          ...(event.approval !== undefined ? { approval: event.approval } : {}),
        };
        return { ...state, patches };
      }
      return {
        ...state,
        patches: [
          ...state.patches,
          { files: event.files, applied: true, ...(event.approval !== undefined ? { approval: event.approval } : {}) },
        ],
      };
    }

    case "approval.auto":
      return {
        ...state,
        activity: bounded(
          [...state.activity, { kind: "running", detail: `auto-approved: ${event.summary}`, at: now() }],
          MAX_ACTIVITY
        ),
      };

    case "notice":
      return {
        ...state,
        notices: bounded([...state.notices, { level: event.level, text: event.text }], MAX_NOTICES),
        ...(event.level === "error" ? { lastError: event.text } : {}),
      };

    case "usage.reported": {
      const previous = state.usage;
      const providerKey = `${event.provider}/${event.model}`;
      const providerChanges = previous
        ? previous.providerChanges.includes(providerKey)
          ? previous.providerChanges
          : [...previous.providerChanges, providerKey]
        : [providerKey];
      const inputTokens = (previous?.inputTokens ?? 0) + event.inputTokens;
      const outputTokens = (previous?.outputTokens ?? 0) + event.outputTokens;
      const cachedInputTokens = (previous?.cachedInputTokens ?? 0) + (event.cachedInputTokens ?? 0);
      const estimatedCostUsd =
        event.estimatedCostUsd === undefined || event.estimatedCostUsd === null || previous?.estimatedCostUsd === null
          ? null
          : (previous?.estimatedCostUsd ?? 0) + event.estimatedCostUsd;
      return {
        ...state,
        usage: {
          provider: event.provider,
          model: event.model,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cachedInputTokens,
          estimatedCostUsd,
          calls: (previous?.calls ?? 0) + 1,
          providerChanges,
        },
      };
    }

    case "task.completed":
      return { ...state, status: "completed" };

    case "task.failed":
      return { ...state, status: "failed", lastError: event.message };

    case "task.cancelled":
      return { ...state, status: "cancelled" };

    case "task.interrupted":
      return { ...state, status: "interrupted" };
    case "task.budget_reached":
      return { ...state, status: "budget-reached", lastError: event.message };
    case "task.stalled":
      return { ...state, status: "stalled", lastError: event.message };

    // ── Extended presentation events ──────────────────────────────────────
    case "git.state":
      return { ...state, git: event.git };

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
        ...(event.detail !== undefined ? { progressDetail: event.detail } : {}),
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
        recoverySuggestions: bounded([...state.recoverySuggestions, event.text], MAX_NOTICES),
      };

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

function sameFiles(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}
