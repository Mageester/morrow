import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { taskCapabilityQueries } from "../../api/task-capability.js";
import { formatElapsed, type TurnWork } from "./chat-projection.js";
import { formatTokens } from "./context-meter.js";

/**
 * The single live status line, above the composer.
 *
 * It exists to answer one question — "is Morrow doing something, and what?" —
 * within a frame of pressing Send, and to keep answering it in place rather
 * than by appending a row every few seconds.
 *
 * Every state it can show is backed by something the runtime actually
 * reported. There is no invented "Analysing…" phase to fill the gap before the
 * provider responds: while nothing has been recorded yet it says so honestly
 * ("Preparing…", then "Thinking…"), and the moment a real step is running it
 * shows that step's own summary.
 */

export type LiveTurnPhase = "sending" | "queued" | "thinking" | "working";

export interface LiveTurnStatusProps {
  /** The running task, when one has been accepted. */
  taskId?: string | undefined;
  /** True between pressing Send and the task being accepted. */
  sending?: boolean | undefined;
  work: TurnWork;
  queued?: boolean | undefined;
  onOpenActivity: () => void;
}

function phaseLabel(phase: LiveTurnPhase, work: TurnWork): string {
  if (phase === "sending") return "Sending…";
  if (phase === "queued") return "Preparing…";
  if (phase === "thinking") return "Thinking…";
  return work.runningEntry?.summary ?? "Working…";
}

export function LiveTurnStatus({
  taskId,
  sending = false,
  work,
  queued = false,
  onOpenActivity,
}: LiveTurnStatusProps) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const capability = useQuery({
    ...taskCapabilityQueries.forTask(taskId ?? ""),
    enabled: Boolean(taskId),
  });

  // The clock restarts per task, so a follow-up turn never inherits the
  // previous turn's elapsed time.
  useEffect(() => {
    setElapsedMs(0);
    const startedAt = Date.now();
    const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(interval);
  }, [taskId, sending]);

  const phase: LiveTurnPhase = !taskId
    ? "sending"
    : queued
      ? "queued"
      : work.runningEntry
        ? "working"
        : "thinking";

  const context = capability.data?.context ?? null;
  const routing = capability.data?.routing ?? null;
  const used = context?.currentModelVisibleTokens ?? context?.currentRequestTokens ?? null;
  const capacity = context?.effectiveContextWindowTokens ?? context?.contextWindowTokens ?? null;
  const elapsed = formatElapsed(elapsedMs);

  return (
    <div aria-live="polite" className="morrow-live-status" data-phase={phase} role="status">
      <span aria-hidden="true" className="morrow-live-status__pulse" />
      <span className="morrow-live-status__label">{phaseLabel(phase, work)}</span>
      <span className="morrow-live-status__meta">
        {elapsed ? <span>{elapsed}</span> : null}
        {work.toolCount > 0 ? (
          <span>{work.toolCount} tool{work.toolCount === 1 ? "" : "s"}</span>
        ) : null}
        {/* Usage is shown only when the runtime supplied both halves. An
            unknown window is never rendered as an unlimited one. */}
        {used !== null && capacity !== null ? (
          <span>{formatTokens(used)} / {formatTokens(capacity)}</span>
        ) : null}
        {routing?.model ? <span className="morrow-live-status__route">{routing.model}</span> : null}
      </span>
      <button
        className="morrow-live-status__inspect"
        onClick={onOpenActivity}
        type="button"
      >
        Activity
      </button>
    </div>
  );
}
