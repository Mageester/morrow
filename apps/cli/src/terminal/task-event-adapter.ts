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

    case "provider.usage": {
      const inputTokens = num(p.inputTokens);
      const outputTokens = num(p.outputTokens);
      const provider = str(p.provider);
      const model = str(p.model);
      if (!provider || !model || inputTokens === undefined || outputTokens === undefined) return [];
      const cachedInputTokens = num(p.cachedInputTokens);
      const estimatedCostUsd = num(p.estimatedCostUsd);
      return withSource([{
        type: "usage.reported",
        provider,
        model,
        inputTokens,
        outputTokens,
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
      }]);
    }

    case "task.progress_warning":
      return withSource([{ type: "notice", level: "warn", text: str(p.message) ?? "No new observable progress yet." }]);

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

    // ── Extended presentation events ──────────────────────────────────────
    case "context.budget_calculated": {
      const maxInput = num(p.maxInputTokens) ?? 0;
      const window = num(p.contextWindowTokens) ?? 0;
      const source = str(p.contextWindowSource) as import("./events.js").ContextUsageInfo["contextWindowSource"] | undefined;
      const knownLimit = source === "fallback" ? null : window || null;
      return withSource([{
        type: "context.usage",
        usage: {
          usedTokens: 0,
          maxTokens: knownLimit ?? maxInput,
          contextLimitTokens: knownLimit,
          contextWindowSource: source ?? "fallback",
          method: "estimate",
          compactedGroups: 0,
          removedGroups: 0,
        },
      }]);
    }

    case "context.exact_count_used":
    case "context.estimate_used": {
      const used = num(p.tokens);
      if (used === undefined) return [];
      return withSource([{
        type: "context.usage",
        usage: {
          usedTokens: used,
          maxTokens: 0,
          method: event.type === "context.exact_count_used" || p.exact === true ? "exact" : "estimate",
          compactedGroups: 0,
          removedGroups: 0,
        },
      }]);
    }

    case "context.trimmed":
    case "context.history_trimmed":
    case "context.compaction_completed": {
      const used = num(p.finalTokens ?? p.tokens);
      const max = num(p.maxInputTokens) ?? 0;
      if (used === undefined) return [];
      return withSource([{
        type: "context.usage",
        usage: {
          usedTokens: used,
          maxTokens: max,
          method: p.exact === true ? "exact" : "estimate",
          compactedGroups: num(p.compactedGroups) ?? 0,
          removedGroups: num(p.removedGroups) ?? num(p.removedMessages) ?? 0,
        },
      }]);
    }

    case "provider.fallback":
      return withSource([{ type: "notice", level: "info", text: `Provider fallback: ${str(p.from) ?? "?"} → ${str(p.servedBy) ?? "?"}` }]);

    case "provider.rate_limited":
      return withSource([{ type: "notice", level: "warn", text: `Rate-limited provider deprioritized: ${Array.isArray(p.deprioritized) ? p.deprioritized.join(", ") : "?"}` }]);

    // Internal plan/step/state churn is intentionally not surfaced.
    default:
      return [];
  }
}
