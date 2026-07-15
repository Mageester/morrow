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
    case "assistant.turn_started": {
      const turnId = str(p.turnId);
      if (turnId === undefined) return [];
      return withSource([{ type: "assistant.turn_start", turnId }]);
    }

    case "assistant.turn_completed": {
      const turnId = str(p.turnId);
      if (turnId === undefined) return [];
      const final = p.final === true;
      const aborted = p.aborted === true;
      return withSource([{ type: "assistant.turn_end", turnId, final, ...(aborted ? { aborted } : {}) }]);
    }

    case "evidence.persisted": {
      const delta = str(p.deltaText);
      if (delta !== undefined) {
        const turnId = str(p.turnId);
        // Pre-turn-boundary backends never send a turnId. Falling back to a
        // fixed id keeps old streams rendering (as one running message, the
        // prior behavior) instead of silently dropping every delta.
        return withSource([{ type: "assistant.delta", turnId: turnId ?? "legacy", text: delta }]);
      }
      const path = str(p.path);
      if (path !== undefined) {
        const action = str(p.action);
        // A persisted WRITE is a change, not a read — it feeds the changed-files
        // list. Beta.28 rendered file writes as "reading <file>", which was wrong.
        if (action === "patched") return withSource([{ type: "patch.applied", files: [path] }]);
        // Directory creation is already covered by the tool's own action line.
        if (action === "created_directory") return [];
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
      // `target` is the orchestrator's display target (path/command); older
      // backends may still send `purpose`. Either becomes the card's purpose.
      const purpose = str(p.target) ?? str(p.purpose);
      const scope = str(p.scope);
      const verification = p.verification === true;
      return withSource([{ type: "tool.start", id, name, ...(purpose ? { purpose } : {}), ...(scope ? { scope } : {}), ...(verification ? { verification: true } : {}) }]);
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
      // A tool failure inside the agent loop is a recovery event, not a product
      // error — the agent is expected to retry or switch strategy. Rendered
      // with warning styling; red is reserved for the task itself failing.
      const name = str(p.toolName) ?? "tool";
      const message = str(p.message) ?? "unknown error";
      return withSource([{ type: "recovery.problem", tool: name, message }]);
    }

    case "tool.strategy_switch": {
      const tool = str(p.tool) ?? str(p.toolName);
      const from = str(p.from);
      const to = str(p.to);
      const reason = str(p.reason);
      const file = str(p.path);
      const strategy = to ? (from ? `${from} → ${to}` : to) : "new approach";
      return withSource([{ type: "recovery.strategy", ...(tool ? { tool } : {}), strategy, ...(reason ? { detail: reason } : {}), ...(file ? { file } : {}) }]);
    }

    case "patch.recovery_feedback": {
      const target = str(p.targetFile) ?? str(p.path);
      const category = (str(p.conflictCategory) ?? "conflict").replace(/[_-]+/g, " ");
      const message = `Patch ${category}${target ? ` in ${target}` : ""}`;
      const strategy =
        str(p.strategy) ??
        str(p.instruction) ??
        (p.retryExhausted === true ? "Stop cleanly and report the patch conflict." : "Regenerate the patch against current file content.");
      const detail = str(p.detail);
      return withSource([
        { type: "recovery.problem", tool: "propose_patch", message, ...(target ? { file: target } : {}) },
        { type: "recovery.strategy", tool: "propose_patch", strategy, ...(detail ? { detail } : {}), ...(target ? { file: target } : {}) },
      ]);
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
      const maxInput = num(p.maximumInputTokens) ?? num(p.maxInputTokens) ?? 0;
      const window = num(p.effectiveRequestLimitTokens) ?? num(p.contextWindowTokens) ?? 0;
      const source = (str(p.effectiveLimitSource) ?? str(p.contextWindowSource)) as import("./events.js").ContextUsageInfo["contextWindowSource"] | undefined;
      const confidence = str(p.contextWindowConfidence) as import("./events.js").ContextUsageInfo["contextWindowConfidence"] | undefined;
      const knownLimit = window || null;
      return withSource([{
        type: "context.usage",
        usage: {
          usedTokens: num(p.currentRequestTokens) ?? 0,
          maxTokens: knownLimit ?? maxInput,
          contextLimitTokens: knownLimit,
          contextWindowSource: source ?? "fallback",
          ...(confidence ? { contextWindowConfidence: confidence } : {}),
          modelCapacityTokens: num(p.modelCapacityTokens) ?? null,
          modelCapacitySource: str(p.modelCapacitySource) ?? "unknown",
          endpointLimitTokens: num(p.endpointLimitTokens) ?? null,
          endpointLimitSource: str(p.endpointLimitSource) ?? "unknown",
          effectiveRequestLimitTokens: num(p.effectiveRequestLimitTokens) ?? null,
          effectiveLimitSource: str(p.effectiveLimitSource) ?? "unknown",
          outputReserveTokens: num(p.outputReserveTokens) ?? num(p.reservedOutputTokens) ?? null,
          safetyMarginTokens: num(p.safetyMarginTokens) ?? null,
          toolReserveTokens: num(p.toolReserveTokens) ?? null,
          framingReserveTokens: num(p.framingReserveTokens) ?? null,
          maximumInputTokens: num(p.maximumInputTokens) ?? num(p.maxInputTokens) ?? null,
          compactionTargetTokens: num(p.compactionTargetTokens) ?? null,
          ...(p.endpointKind !== undefined ? { endpointKind: p.endpointKind as "default" | "custom" | "injected" } : {}),
          endpointHost: (p.endpointHost as string | null | undefined) ?? null,
          currentRequestTokens: num(p.currentRequestTokens) ?? null,
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
