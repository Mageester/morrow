import { memo, useState } from "react";
import { Markdown } from "../../components/markdown.js";
import { workSummaryLabel, type TurnBlock, type TurnWork, type WorkStep } from "./chat-projection.js";
import { NotableEvent, WorkStepRow } from "./work-summary.js";

/**
 * An assistant turn, read in the order it happened.
 *
 * Morrow does not answer in one breath. It says what it is about to do, does
 * it, reports what it found, and goes again — and the durable projection has
 * always recorded exactly that (`activity-projection.ts` anchors each turn's
 * narration at the point in the run where it streamed). What the conversation
 * used to render instead was a summary box of every tool the task ran, then a
 * single block of text: the sequence flattened, so the reader could see what
 * was said and what was done but never which went with which.
 *
 * This renders the sequence. Prose is prose. A burst of tool calls is one
 * quiet run of rows between two pieces of prose. Nothing here is new
 * information — it is the same entries, in the order they were recorded.
 */

export interface TurnTimelineProps {
  blocks: readonly TurnBlock[];
  projectId: string;
  conversationId: string;
  /** The turn is still producing blocks; the last run is live. */
  streaming: boolean;
}

export const TurnTimeline = memo(function TurnTimeline({
  blocks,
  projectId,
  conversationId,
  streaming,
}: TurnTimelineProps) {
  return (
    <div className="morrow-turn-timeline" data-testid="turn-timeline">
      {blocks.map((block, index) => {
        if (block.type === "prose") {
          return (
            <div
              className="morrow-conversation-message__content morrow-conversation-message__content--markdown"
              data-testid="turn-prose"
              key={block.key}
            >
              {/* Only the final block can still be growing; marking an earlier
                  one as streaming would keep re-running the partial-markdown
                  repair on text that has already settled. */}
              <Markdown streaming={streaming && index === blocks.length - 1} text={block.text} />
            </div>
          );
        }
        if (block.type === "notable") return <NotableEvent entry={block.entry} key={block.key} />;
        return (
          <WorkRun
            conversationId={conversationId}
            key={block.key}
            projectId={projectId}
            steps={block.steps}
          />
        );
      })}
    </div>
  );
});

/**
 * Beyond this many rows a single run stops being a paragraph-sized object and
 * starts being a log. The rest stay one click away rather than being dropped.
 */
const VISIBLE_STEPS = 8;

/** One uninterrupted stretch of tool work, between two things Morrow said. */
const WorkRun = memo(function WorkRun({
  steps,
  projectId,
  conversationId,
}: {
  steps: readonly WorkStep[];
  projectId: string;
  conversationId: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const hidden = Math.max(0, steps.length - VISIBLE_STEPS);
  const visible = showAll ? steps : steps.slice(0, VISIBLE_STEPS);

  return (
    <div className="morrow-turn-run" data-testid="turn-work-run">
      <ol className="morrow-work__steps">
        {visible.map((step) => (
          <WorkStepRow conversationId={conversationId} key={step.key} projectId={projectId} step={step} />
        ))}
      </ol>
      {hidden > 0 && !showAll ? (
        <button className="morrow-work__more" onClick={() => setShowAll(true)} type="button">
          {hidden} more {hidden === 1 ? "step" : "steps"}
        </button>
      ) : null}
    </div>
  );
});

export interface TurnFooterProps {
  work: TurnWork;
  onInspect?: (() => void) | undefined;
}

/**
 * What the turn cost, once the turn is over.
 *
 * Above the answer this was a claim the reader had to take on trust before
 * they had read anything. Below it, it is a receipt — and it is the one place
 * the totals belong now that the individual steps are inline where they
 * happened.
 *
 * Nothing here while the turn is still running. "Is Morrow doing something,
 * and what?" belongs to the one live status line above the composer
 * (`live-status.tsx`); a second "Working…" a few pixels away from it is the
 * kind of duplicate reassurance that makes a surface feel restless.
 */
export const TurnFooter = memo(function TurnFooter({ work, onInspect }: TurnFooterProps) {
  if (work.toolCount === 0 || work.status === "running") return null;
  return (
    <p className="morrow-turn-footer" data-status={work.status} data-testid="turn-footer">
      <span aria-hidden="true" className="morrow-turn-footer__mark" />
      <span className="morrow-turn-footer__label">{workSummaryLabel(work)}</span>
      {onInspect ? (
        <button className="morrow-turn-footer__inspect" onClick={onInspect} type="button">
          Open full activity
        </button>
      ) : null}
    </p>
  );
});
