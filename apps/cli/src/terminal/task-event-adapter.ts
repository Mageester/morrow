/**
 * Adapter: orchestrator SSE `TaskEvent`s → normalized `TerminalEvent`s.
 *
 * This is the only place that knows the orchestrator's wire shapes. It keeps the
 * terminal runtime decoupled from the agent runtime: the renderer never sees a
 * raw `TaskEvent`. We deliberately surface only *observable* actions and never
 * internal plan-state churn (plan.created / step.* / agent.state_changed), to
 * match Morrow's "show what it did, not what it thought" principle.
 *
 * `approval.requested` is intentionally NOT mapped — it is an input event the
 * interactive controller handles by prompting, not a render event.
 */
import type { TerminalEvent } from "./events.js";

export interface RawTaskEvent {
  id?: string;
  sequence?: number;
  type: string;
  payload: Record<string, unknown>;
}

export type MappedTerminalEvent = TerminalEvent & { sourceEventId?: string };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Map one SSE task event to zero or more terminal events. */
export function mapTaskEvent(event: RawTaskEvent): MappedTerminalEvent[] {
  const p = event.payload ?? {};
  const withSource = (events: TerminalEvent[]): MappedTerminalEvent[] => {
    if (!event.id) return events;
    return events.map((mapped) => ({ ...mapped, sourceEventId: event.id! }));
  };
  switch (event.type) {
    case "evidence.persisted": {
      const delta = str(p.deltaText);
      if (delta !== undefined) return withSource([{ type: "assistant.delta", text: delta }]);
      const path = str(p.path);
      if (path !== undefined) {
        const size = num(p.size);
        return withSource([{ type: "activity", kind: "reading", detail: size !== undefined ? `${path} (${size} bytes)` : path }]);
      }
      return [];
    }

    case "workspace.inspected": {
      const kind = str(p.kind);
      const path = str(p.path);
      const count = num(p.resultCount);
      const activityKind = kind === "search_text" || kind === "search_files" ? "searching" : "inspecting";
      return withSource([
        {
          type: "activity",
          kind: activityKind,
          ...(path !== undefined ? { detail: path } : {}),
          ...(count !== undefined ? { count } : {}),
        },
      ]);
    }

    case "approval.resolved": {
      if (p.auto === true) {
        const id = str(p.approvalId) ?? "";
        const summary = str(p.decision) ?? "auto-approved";
        return withSource([{ type: "approval.auto", id, summary }]);
      }
      return [];
    }

    case "tool.started": {
      const id = str(p.id);
      const name = str(p.toolName);
      if (!id || !name) return [];
      const purpose = str(p.purpose);
      const scope = str(p.scope);
      return withSource([{ type: "tool.start", id, name, ...(purpose ? { purpose } : {}), ...(scope ? { scope } : {}) }]);
    }

    case "tool.completed": {
      const id = str(p.id);
      if (!id) return [];
      const status = p.status === "failed" ? "failed" : "completed";
      const elapsedMs = num(p.elapsedMs);
      const summary = str(p.summary);
      const error = str(p.error);
      const outputRef = str(p.outputRef);
      return withSource([{ type: "tool.end", id, status, ...(elapsedMs !== undefined ? { elapsedMs } : {}), ...(summary ? { summary } : {}), ...(error ? { error } : {}), ...(outputRef ? { outputRef } : {}) }]);
    }

    case "tool.failed": {
      const name = str(p.toolName) ?? "tool";
      const message = str(p.message) ?? "unknown error";
      return withSource([{ type: "notice", level: "warn", text: `${name} failed: ${message}` }]);
    }

    case "task.failed":
      return withSource([{ type: "task.failed", message: str(p.message) ?? "unknown error" }]);
    case "task.completed":
      return withSource([{ type: "task.completed" }]);
    case "task.cancelled":
      return withSource([{ type: "task.cancelled" }]);
    case "task.interrupted":
      if (str(p.reason) === "turn_budget_reached") {
        return withSource([{ type: "task.budget_reached", message: str(p.message) ?? "Task budget reached" }]);
      }
      if (str(p.reason) === "stalled") {
        return withSource([{ type: "task.stalled", message: str(p.message) ?? "Task stalled" }]);
      }
      return withSource([{ type: "task.interrupted" }]);

    // Internal plan/step/state churn is intentionally not surfaced.
    default:
      return [];
  }
}
