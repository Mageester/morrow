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
  type: string;
  payload: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Map one SSE task event to zero or more terminal events. */
export function mapTaskEvent(event: RawTaskEvent): TerminalEvent[] {
  const p = event.payload ?? {};
  switch (event.type) {
    case "evidence.persisted": {
      const delta = str(p.deltaText);
      if (delta !== undefined) return [{ type: "assistant.delta", text: delta }];
      const path = str(p.path);
      if (path !== undefined) {
        const size = num(p.size);
        return [{ type: "activity", kind: "reading", detail: size !== undefined ? `${path} (${size} bytes)` : path }];
      }
      return [];
    }

    case "workspace.inspected": {
      const kind = str(p.kind);
      const path = str(p.path);
      const count = num(p.resultCount);
      const activityKind = kind === "search_text" || kind === "search_files" ? "searching" : "inspecting";
      return [
        {
          type: "activity",
          kind: activityKind,
          ...(path !== undefined ? { detail: path } : {}),
          ...(count !== undefined ? { count } : {}),
        },
      ];
    }

    case "approval.resolved": {
      if (p.auto === true) {
        const id = str(p.approvalId) ?? "";
        const summary = str(p.decision) ?? "auto-approved";
        return [{ type: "approval.auto", id, summary }];
      }
      return [];
    }

    case "tool.failed": {
      const name = str(p.toolName) ?? "tool";
      const message = str(p.message) ?? "unknown error";
      return [{ type: "notice", level: "warn", text: `${name} failed: ${message}` }];
    }

    case "task.failed":
      return [{ type: "task.failed", message: str(p.message) ?? "unknown error" }];
    case "task.completed":
      return [{ type: "task.completed" }];
    case "task.cancelled":
      return [{ type: "task.cancelled" }];
    case "task.interrupted":
      return [{ type: "task.interrupted" }];

    // Internal plan/step/state churn is intentionally not surfaced.
    default:
      return [];
  }
}
