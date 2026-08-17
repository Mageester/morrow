import type { WebConversationActivityEntry } from "@morrow/contracts";
import { ChevronRight, Loader2 } from "lucide-react";
import { memo, useState } from "react";
import { ActivityDetails, activityIcon } from "./activity-panel.js";
import { formatElapsed, workSummaryLabel, type TurnWork, type WorkStep } from "./chat-projection.js";

/**
 * The work surface for one assistant turn.
 *
 * One row while Morrow is working, updated in place; one row once it has
 * finished. Opening it reveals the meaningful steps — never the full event
 * feed, which is what Activity / Inspect is for. The distinction matters: this
 * component exists to let a reader confirm the shape of the work without
 * leaving the conversation, not to reproduce the ledger inside it.
 */

function statusMark(status: TurnWork["status"]) {
  if (status === "running") {
    return <Loader2 aria-hidden="true" className="morrow-work__spinner" size={13} />;
  }
  if (status === "failed") return <span aria-hidden="true" className="morrow-work__mark">⚠</span>;
  return <span aria-hidden="true" className="morrow-work__mark">✓</span>;
}

export interface WorkSummaryProps {
  work: TurnWork;
  /** Opens the Activity / Inspect drawer for the full record. */
  onInspect?: (() => void) | undefined;
}

export const WorkSummary = memo(function WorkSummary({ work, onInspect }: WorkSummaryProps) {
  const [open, setOpen] = useState(false);
  if (work.steps.length === 0 && work.status !== "running") return null;

  // While running, the header carries what is happening right now instead of a
  // second row appearing beneath it every few seconds.
  const currentLabel = work.status === "running"
    ? work.runningEntry?.summary ?? "Thinking…"
    : null;

  return (
    <div
      className="morrow-work"
      data-status={work.status}
      data-testid="turn-work-summary"
    >
      <button
        aria-expanded={open}
        className="morrow-work__header"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="morrow-work__status">{statusMark(work.status)}</span>
        <span className="morrow-work__label">{workSummaryLabel(work)}</span>
        {currentLabel ? <span className="morrow-work__current">{currentLabel}</span> : null}
        <ChevronRight
          aria-hidden="true"
          className={`morrow-work__chevron${open ? " is-open" : ""}`}
          size={13}
        />
      </button>
      {open ? (
        <div className="morrow-work__body">
          {work.steps.length === 0 ? (
            <p className="morrow-work__empty">No tool work has been recorded for this turn yet.</p>
          ) : (
            <ol className="morrow-work__steps">
              {work.steps.map((step) => <WorkStepRow key={step.key} step={step} />)}
            </ol>
          )}
          {onInspect ? (
            <button className="morrow-work__inspect" onClick={onInspect} type="button">
              Open full activity
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const WorkStepRow = memo(function WorkStepRow({ step }: { step: WorkStep }) {
  if (step.type === "group") return <GroupedStepRow entries={step.entries} label={step.label} />;
  return <SingleStepRow entry={step.entry} />;
});

/**
 * One tool call. The running state is replaced by the completed state in place
 * — the entry keeps its id across the transition, so React updates this row
 * rather than appending a second one.
 */
const SingleStepRow = memo(function SingleStepRow({ entry }: { entry: WebConversationActivityEntry }) {
  const [open, setOpen] = useState(false);
  const duration = formatElapsed(entry.durationMs);
  const hasDetails = Boolean(entry.detail || entry.target || entry.toolName || entry.exitCode !== null);

  return (
    <li className="morrow-work__step" data-kind={entry.kind} data-status={entry.status}>
      <button
        aria-expanded={hasDetails ? open : undefined}
        className="morrow-work__step-header"
        disabled={!hasDetails}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden="true" className="morrow-work__step-state" />
        <span aria-hidden="true" className="morrow-work__step-icon">{activityIcon(entry.kind)}</span>
        <span className="morrow-work__step-summary">{entry.summary}</span>
        {duration ? <span className="morrow-work__step-meta">{duration}</span> : null}
        {entry.exitCode !== null && entry.exitCode !== 0 ? (
          <span className="morrow-work__step-exit">exit {entry.exitCode}</span>
        ) : null}
      </button>
      {open && hasDetails ? (
        <div className="morrow-work__step-body">
          <ActivityDetails item={entry} />
        </div>
      ) : null}
    </li>
  );
});

/**
 * Repetitive read-only operations, collapsed to one row. Expanding lists the
 * individual targets: the count answers "did it look around?", the list answers
 * "at what?", and neither needs eight full-height rows to do it.
 */
const GroupedStepRow = memo(function GroupedStepRow({
  entries,
  label,
}: {
  entries: readonly WebConversationActivityEntry[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="morrow-work__step" data-kind="group" data-status="completed">
      <button
        aria-expanded={open}
        className="morrow-work__step-header"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span aria-hidden="true" className="morrow-work__step-state" />
        <span aria-hidden="true" className="morrow-work__step-icon">{activityIcon(entries[0]!.kind)}</span>
        <span className="morrow-work__step-summary">{label}</span>
        <span className="morrow-work__step-count">{entries.length}</span>
      </button>
      {open ? (
        <ul className="morrow-work__group-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <code>{entry.target ?? entry.summary}</code>
            </li>
          ))}
        </ul>
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
