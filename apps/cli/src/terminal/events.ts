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
}

export type TerminalEvent =
  | { type: "session.started"; meta: SessionMeta }
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
  | { type: "task.interrupted" };

export type TerminalEventType = TerminalEvent["type"];
