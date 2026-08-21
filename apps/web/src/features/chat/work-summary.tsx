import type { WebConversationActivityEntry } from "@morrow/contracts";
import { ChevronRight, Loader2 } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { activityIcon } from "./activity-panel.js";
import { formatElapsed, workSummaryLabel, type TurnWork, type WorkStep } from "./chat-projection.js";
import { EvidenceCard } from "./evidence-card.js";

/**
 * The work surface for one assistant turn.
 *
 * Every step the turn ran, one line each, shown by default: what tool, what it
 * acted on, what came back. A reader should be able to answer "what did it
 * actually do?" by looking, not by opening something first — which is what the
 * previous single collapsed row asked of them, and why a completed turn read
 * as a claim rather than a record.
 *
 * Opening a line reveals what that step recorded. That is a request of its own
 * (see EvidenceCard): the transcript carries handles, not output, so the list
 * stays a list however much the run produced.
 *
 * This is still not the ledger. Routine bookkeeping is classified out in
 * chat-projection.ts and remains in Activity / Inspect, where the question is
 * "in what order did everything happen?" rather than "what was done?".
 */

function statusMark(status: TurnWork["status"]) {
  if (status === "running") {
    return <Loader2 aria-hidden="true" className="morrow-work__spinner" size={13} />;
  }
  if (status === "failed") return <span aria-hidden="true" className="morrow-work__mark">⚠</span>;
  return <span aria-hidden="true" className="morrow-work__mark">✓</span>;
}

/**
 * Wall-clock elapsed time for a turn that is still running.
 *
 * Timing a live run from its recorded events makes the counter stall for as
 * long as the model is thinking — the very stretch a reader most wants counted.
 * The clock ticks against `startedAt` instead, and stops entirely once the turn
 * settles, at which point the recorded span is the accurate figure.
 */
function useRunningElapsed(startedAt: number | null, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running]);
  if (!running || startedAt === null) return null;
  return Math.max(0, now - startedAt);
}

/**
 * Beyond this many steps the list stops being scannable and starts being a log.
 * The rest stay one click away rather than being dropped — a turn that ran
 * forty tools should say so, and let the reader ask for the rest.
 */
const VISIBLE_STEPS = 12;

export interface WorkSummaryProps {
  work: TurnWork;
  projectId: string;
  conversationId: string;
  /** Opens the Activity / Inspect drawer for the full record. */
  onInspect?: (() => void) | undefined;
}

export const WorkSummary = memo(function WorkSummary({
  work,
  projectId,
  conversationId,
  onInspect,
}: WorkSummaryProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const running = work.status === "running";
  const elapsedMs = useRunningElapsed(work.startedAt, running);
  // A turn with no recorded work has nothing to summarise. Before the first
  // tool starts, the turn's own waiting line and the live status say so; a
  // third "Working" on the same screen is noise, not reassurance.
  if (work.steps.length === 0) return null;

  const hidden = Math.max(0, work.steps.length - VISIBLE_STEPS);
  const visible = showAll ? work.steps : work.steps.slice(0, VISIBLE_STEPS);

  return (
    <div
      className="morrow-work"
      data-status={work.status}
      data-testid="turn-work-summary"
    >
      <button
        aria-expanded={!collapsed}
        className="morrow-work__header"
        onClick={() => setCollapsed((value) => !value)}
        type="button"
      >
        <span className="morrow-work__status">{statusMark(work.status)}</span>
        <span className="morrow-work__label">{workSummaryLabel(work, elapsedMs)}</span>
        <ChevronRight
          aria-hidden="true"
          className={`morrow-work__chevron${collapsed ? "" : " is-open"}`}
          size={13}
        />
      </button>

      {collapsed ? null : (
        <div className="morrow-work__body">
          <ol className="morrow-work__steps">
            {visible.map((step) => (
              <WorkStepRow
                conversationId={conversationId}
                key={step.key}
                projectId={projectId}
                step={step}
              />
            ))}
          </ol>
          {hidden > 0 && !showAll ? (
            <button className="morrow-work__more" onClick={() => setShowAll(true)} type="button">
              {hidden} more {hidden === 1 ? "step" : "steps"}
            </button>
          ) : null}
          {onInspect ? (
            <button className="morrow-work__inspect" onClick={onInspect} type="button">
              Open full activity
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
});

const WorkStepRow = memo(function WorkStepRow({
  step,
  projectId,
  conversationId,
}: {
  step: WorkStep;
  projectId: string;
  conversationId: string;
}) {
  if (step.type === "group") {
    return <GroupedStepRow conversationId={conversationId} entries={step.entries} label={step.label} projectId={projectId} />;
  }
  return <SingleStepRow conversationId={conversationId} entry={step.entry} projectId={projectId} />;
});

/**
 * One tool call. The running state is replaced by the completed state in place
 * — the entry keeps its id across the transition, so React updates this row
 * rather than appending a second one.
 */
const SingleStepRow = memo(function SingleStepRow({
  entry,
  projectId,
  conversationId,
}: {
  entry: WebConversationActivityEntry;
  projectId: string;
  conversationId: string;
}) {
  const [open, setOpen] = useState(false);
  const duration = formatElapsed(entry.durationMs);
  const failed = entry.exitCode !== null && entry.exitCode !== 0;

  return (
    <li className="morrow-work__step" data-kind={entry.kind} data-status={entry.status}>
      <button
        aria-expanded={open}
        className="morrow-work__step-header"
        data-testid="work-step"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden="true" className="morrow-work__step-state" />
        <span aria-hidden="true" className="morrow-work__step-icon">{activityIcon(entry.kind)}</span>
        <span className="morrow-work__step-summary">{entry.summary}</span>
        {/* The right edge is where the result lives, always in the same place,
            so a column of steps can be read down rather than across. */}
        {entry.resultCount !== null ? (
          <span className="morrow-work__step-meta">{entry.resultCount.toLocaleString("en-US")}</span>
        ) : null}
        {failed ? <span className="morrow-work__step-exit">exit {entry.exitCode}</span> : null}
        {duration ? <span className="morrow-work__step-meta">{duration}</span> : null}
        <ChevronRight
          aria-hidden="true"
          className={`morrow-work__step-chevron${open ? " is-open" : ""}`}
          size={12}
        />
      </button>
      {open ? (
        <div className="morrow-work__step-body">
          <EvidenceCard conversationId={conversationId} entry={entry} projectId={projectId} />
        </div>
      ) : null}
    </li>
  );
});

/**
 * Repetitive read-only operations, collapsed to one row. Expanding lists the
 * individual targets, each openable in turn: the count answers "did it look
 * around?", the list answers "at what?", and the rows answer "and what came
 * back?" without eight full-height entries to get there.
 */
const GroupedStepRow = memo(function GroupedStepRow({
  entries,
  label,
  projectId,
  conversationId,
}: {
  entries: readonly WebConversationActivityEntry[];
  label: string;
  projectId: string;
  conversationId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="morrow-work__step" data-kind="group" data-status="completed">
      <button
        aria-expanded={open}
        className="morrow-work__step-header"
        data-testid="work-step"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden="true" className="morrow-work__step-state" />
        <span aria-hidden="true" className="morrow-work__step-icon">{activityIcon(entries[0]!.kind)}</span>
        <span className="morrow-work__step-summary">{label}</span>
        <span className="morrow-work__step-count">{entries.length}</span>
        <ChevronRight
          aria-hidden="true"
          className={`morrow-work__step-chevron${open ? " is-open" : ""}`}
          size={12}
        />
      </button>
      {open ? (
        <ol className="morrow-work__group-list">
          {entries.map((entry) => (
            <SingleStepRow conversationId={conversationId} entry={entry} key={entry.id} projectId={projectId} />
          ))}
        </ol>
      ) : null}
    </li>
  );
});

/**
 * An exceptional transition — a fallback, a compaction, an approval, a recovery.
 * These stay in the reading column because a reader who misses one can
 * misread everything after it.
 */
export const NotableEvent = memo(function NotableEvent({ entry }: { entry: WebConversationActivityEntry }) {
  return (
    <p className="morrow-turn-notable" data-status={entry.status} data-testid="turn-notable">
      <span aria-hidden="true" className="morrow-turn-notable__mark" />
      <span className="morrow-turn-notable__summary">{entry.summary}</span>
      {entry.detail ? <span className="morrow-turn-notable__detail">{entry.detail}</span> : null}
    </p>
  );
});
