/**
 * The normalized terminal event model.
 *
 * Every producer — the agent runtime (via the SSE adapter), commands, tools,
 * approvals, plans, patches, jobs, model streaming — emits a `TerminalEvent`.
 * Producers describe *what happened*; they never format output. The reducer
 * folds events into `TerminalState`, and the renderer owns everything visible.
 *
 * This decoupling is the core architectural rule of the terminal runtime: there
 * is no path from a producer to the screen that bypasses an event.
 */

/** Observable agent actions. Internal chain-of-thought is never an activity. */
export type ActivityKind =
  | "inspecting"
  | "reading"
  | "searching"
  | "planning"
  | "running"
  | "applying_patch"
  | "verifying"
  | "waiting"
  | "retrying"
  | "delegating"
  | "completing";

/** Who authorized a tool/patch: an explicit human, auto-approval (YOLO), or a
 *  previously granted project trust. Surfaced so provenance is always visible. */
export type ApprovalSource = "human" | "auto" | "trusted";

/** Immutable session header facts, set once when the session starts. */
export interface SessionMeta {
  greeting: string;
  name?: string;
  projectName: string;
  workspacePath: string;
  branch: string;
  provider: string;
  model: string;
  /** Human privacy label, e.g. "local · on this machine" or "cloud". */
  privacy: string;
  /** Human mode label, e.g. "Agent · approvals required" or YOLO. */
  mode: string;
  memory: boolean;
  autoApprove: boolean;
  /** Whether a usable model provider is configured. Drives onboarding guidance
   *  in the empty-state welcome panel; undefined means "not probed". */
  providerConfigured?: boolean;
  /** Whether the workspace is a Git repository. Drives onboarding guidance;
   *  undefined means "not probed". */
  gitRepo?: boolean;
  /** Whether this session resumed prior conversation history. */
  resumed?: boolean;
  /** Count of prior messages restored on resume (for the resume digest). */
  priorMessages?: number;
}

/** Git state snapshot shown in header/status. */
export interface GitStateInfo {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

/** Context usage shown in status footer. */
export interface ContextUsageInfo {
  usedTokens: number;
  maxTokens: number;
  /** Known model context window. Null means the registry could not assert it. */
  contextLimitTokens?: number | null;
  contextWindowSource?: "known-model" | "model-metadata" | "provider-metadata" | "endpoint-override" | "user-config" | "fallback" | "unknown";
  /** The canonical ModelBudget.contextWindowConfidence, when the emitting
   *  event is recent enough to carry it — "verified"/"configured"/
   *  "unverified" (see routing/model-budget.ts). Absent for older event rows
   *  predating that field; callers must derive an honest label from
   *  `contextWindowSource` in that case, never assume "verified". */
  contextWindowConfidence?: "verified" | "configured" | "unverified";
  modelCapacityTokens?: number | null;
  modelCapacitySource?: string;
  endpointLimitTokens?: number | null;
  endpointLimitSource?: string;
  effectiveRequestLimitTokens?: number | null;
  effectiveLimitSource?: string;
  outputReserveTokens?: number | null;
  /** Safety-margin, tool-definition, and message-framing reserve — the parts
   *  of ModelBudget.totalReserveTokens beyond the output reserve. Absent for
   *  older event rows; never fabricated when unknown. */
  safetyMarginTokens?: number | null;
  toolReserveTokens?: number | null;
  framingReserveTokens?: number | null;
  maximumInputTokens?: number | null;
  /** The soft compaction target (ModelBudget.compactionTargetTokens) — never
   *  a provider-enforced ceiling, just the point deterministic trimming aims
   *  for before the real request-size gate. Null/absent when unknown. */
  compactionTargetTokens?: number | null;
  endpointKind?: "default" | "custom" | "injected";
  endpointHost?: string | null;
  currentRequestTokens?: number | null;
  /** Percent of the known context window consumed; null when the limit is unknown. */
  percent?: number | null;
  method: "exact" | "estimate";
  compactedGroups: number;
  removedGroups: number;
}

export interface UsageInfo {
  provider: string;
  model: string;
  /** Total input tokens (fresh + cached combined), as reported by the
   * provider. Always a complete, exact sum across every response. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Known cached-token subtotal. Only the exact, complete cumulative cached
   * total when `cacheBreakdownComplete` is true; otherwise a partial
   * subtotal (a lower bound) from only the responses that reported one —
   * never coerced to 0 for "the provider didn't say," and never displayed
   * as the whole when it is partial. Null only when no response so far has
   * reported a breakdown at all. */
  cachedInputTokens: number | null;
  /** True only when every response folded into this total reported a cache
   * breakdown. False as soon as one didn't — from that point, inputTokens
   * minus cachedInputTokens is NOT necessarily the fresh total. */
  cacheBreakdownComplete: boolean;
  estimatedCostUsd: number | null;
  calls: number;
  providerChanges: string[];
}

/** Background process info. */
export interface ProcessInfo {
  id: string;
  name: string;
  pid?: number;
  status: "running" | "exited" | "killed";
  exitCode?: number;
}

/** Worktree info. */
export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  status: "active" | "abandoned" | "removed";
}

/** Agent/subagent info. */
export interface AgentInfo {
  id: string;
  name: string;
  role: "primary" | "subagent" | "worktree";
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  taskId?: string;
}

/** Integration attempt info. */
export interface IntegrationInfo {
  id: string;
  worktreeId: string;
  branch: string;
  status: "pending" | "applied" | "conflict" | "rejected";
  conflicts?: string[];
}

/** Progress stage for grouped activity. */
export type ProgressStage =
  | "understanding"
  | "inspecting"
  | "planning"
  | "editing"
  | "running_checks"
  | "waiting_for_approval"
  | "verifying"
  | "completed"
  | "failed";

export type TerminalEvent =
  | { type: "session.started"; meta: SessionMeta }
  | { type: "plan.snapshot"; steps: Array<{ id: string; title: string; status: "pending" | "running" | "completed" | "failed" | "skipped" }> }
  | {
      type: "routing";
      provider: string;
      model: string;
      preset: string;
      fallback: boolean;
      overridden: boolean;
      privacy: string;
    }
  | { type: "user.message"; text: string }
  /** A new model turn has begun. Every delta/end after this belongs to `turnId`
   *  until the matching `assistant.turn_end` — turns are never inferred from
   *  "the last message happens to be streaming". */
  | { type: "assistant.turn_start"; turnId: string }
  | { type: "assistant.delta"; turnId: string; text: string }
  /** `final` is true only for the turn that produced no further tool calls —
   *  the user-facing canonical answer. Every other turn is intermediate
   *  narration, kept for diagnostics but never presented as the answer. */
  | { type: "assistant.turn_end"; turnId: string; final: boolean; aborted?: boolean }
  /** Safety net: closes whichever turn is currently open, if any, without
   *  needing to know its id. Used when a stream ends without a matching
   *  `assistant.turn_end` (dropped connection, pre-fix backend). */
  | { type: "assistant.end" }
  | { type: "activity"; kind: ActivityKind; detail?: string; count?: number }
  | { type: "tool.start"; id: string; name: string; purpose?: string; scope?: string; verification?: boolean }
  | {
      type: "tool.end";
      id: string;
      status: "completed" | "failed";
      elapsedMs?: number;
      summary?: string;
      error?: string;
      approval?: ApprovalSource;
      /** Reference to complete output retained in task storage (for `/output`). */
      outputRef?: string;
    }
  | {
      type: "patch.proposed";
      files: string[];
      additions?: number;
      deletions?: number;
      explanation?: string;
      approval?: ApprovalSource;
    }
  | { type: "patch.applied"; files: string[]; approval?: ApprovalSource }
  | { type: "approval.auto"; id: string; summary: string }
  /** A tool call failed inside the agent loop. This is a *recovery* event, not
   *  a product error: the agent is expected to retry or switch strategy. It is
   *  rendered with warning styling and only escalates to error styling if the
   *  task itself ends failed. */
  | { type: "recovery.problem"; tool: string; message: string; file?: string }
  /** The agent switched strategy after a failure (e.g. patch → full-file
   *  rewrite). Marks the matching problem as "retrying". `file`, when known,
   *  scopes resolution to that file so an unrelated file's success can never
   *  incorrectly mark this problem recovered. */
  | { type: "recovery.strategy"; tool?: string; strategy: string; detail?: string; file?: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "usage.reported"; provider: string; model: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number; estimatedCostUsd?: number | null }
  | { type: "task.completed" }
  | { type: "task.failed"; message: string }
  | { type: "task.cancelled" }
  | { type: "task.interrupted" }
  | { type: "task.budget_reached"; message: string }
  | { type: "task.stalled"; message: string }
  // ── Extended presentation events ──────────────────────────────────────
  | { type: "git.state"; git: GitStateInfo }
  | { type: "context.usage"; usage: ContextUsageInfo }
  | { type: "progress.stage"; stage: ProgressStage; detail?: string }
  | { type: "process.update"; processes: ProcessInfo[] }
  | { type: "worktree.update"; worktrees: WorktreeInfo[] }
  | { type: "agent.update"; agents: AgentInfo[] }
  | { type: "integration.update"; integrations: IntegrationInfo[] }
  | { type: "recovery.suggestion"; text: string }
  /** Ordinary text submitted while a task is still streaming. Never silently
   *  discarded and never merged into the running task — it is held, shown
   *  distinctly from both the activity feed and slash-command notices, and
   *  sent as the next `user.message` once the running task ends. */
  | { type: "redirect.queued"; text: string }
  /** The oldest queued redirect is about to be sent as a new task. */
  | { type: "redirect.sent" };

export type TerminalEventType = TerminalEvent["type"];
