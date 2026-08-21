import type { ThreadHandoff } from "@morrow/contracts";
import { Link } from "@tanstack/react-router";
import { memo, useState } from "react";
import { TeammateAvatar } from "../roster/teammate-avatar.js";

/**
 * A handoff, shown at the point in the thread where it happened.
 *
 * Work given to another teammate runs in that teammate's own thread, under
 * that teammate's own policy. Without a row here it would happen invisibly —
 * you would ask for something, watch nothing, and find an answer with no
 * account of who produced it. So the row states who was asked, what for, and
 * what came back, and links to their thread for the working record.
 */

const RUNNING_STATUSES = new Set<ThreadHandoff["status"]>(["queued", "running"]);

export interface HandoffRowProps {
  handoff: ThreadHandoff;
  projectId: string;
}

export const HandoffRow = memo(function HandoffRow({ handoff, projectId }: HandoffRowProps) {
  const [open, setOpen] = useState(false);
  const running = RUNNING_STATUSES.has(handoff.status);
  const failed = handoff.status === "failed";

  return (
    <div className="morrow-handoff" data-status={handoff.status} data-testid="thread-handoff">
      <button
        aria-expanded={open}
        className="morrow-handoff__head"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <TeammateAvatar name={handoff.agentName} size="sm" />
        <span className="morrow-handoff__label">
          {running
            ? `Asking ${handoff.agentName}…`
            : failed
              ? `${handoff.agentName} could not finish`
              : handoff.status === "cancelled"
                ? `${handoff.agentName} was stopped`
                : `${handoff.agentName} replied`}
        </span>
        <span className="morrow-handoff__objective">{handoff.objective}</span>
        {handoff.toolCount > 0 ? (
          <span className="morrow-handoff__meta">
            {handoff.toolCount} {handoff.toolCount === 1 ? "tool" : "tools"}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="morrow-handoff__body">
          <p className="morrow-handoff__asked">
            <span>Asked for</span>
            {handoff.objective}
          </p>
          {handoff.result ? (
            <p className="morrow-handoff__result">
              <span>{handoff.agentName} said</span>
              {handoff.result}
            </p>
          ) : (
            <p className="morrow-handoff__result morrow-handoff__result--empty">
              {running ? `${handoff.agentName} has not answered yet.` : `${handoff.agentName} left no answer.`}
            </p>
          )}
          {handoff.conversationId ? (
            <Link
              className="morrow-handoff__open"
              params={{ conversationId: handoff.conversationId }}
              search={{ projectId }}
              to="/chats/$conversationId"
            >
              Open {handoff.agentName}'s thread
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
