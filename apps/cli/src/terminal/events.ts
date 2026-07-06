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
  method: "exact" | "estimate";
  compactedGroups: number;
  removedGroups: number;
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
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.end" }
  | { type: "activity"; kind: ActivityKind; detail?: string; count?: number }
  | { type: "tool.start"; id: string; name: string; purpose?: string; scope?: string }
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
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
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
  | { type: "recovery.suggestion"; text: string };

export type TerminalEventType = TerminalEvent["type"];
