import type { WebConversationActivityEntry } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { conversationQueries } from "../../api/conversations.js";
import { projectQueries } from "../../api/projects.js";

/**
 * The live-work rail: what Morrow is doing for this conversation, in human
 * language, beside the answer it is producing.
 *
 * Reads the same redacted, allow-listed activity projection the inspector
 * uses — no second source, no new endpoint. Every number shown is one the
 * runtime actually reported; nothing is estimated to fill the panel, because a
 * confident-looking fabricated cost is worse than an absent one.
 */
export function ConversationRail({
  active,
  conversationId,
  onOpenInspector,
  projectId,
}: {
  /** True while a task is queued or streaming. */
  active: boolean;
  conversationId: string;
  /** Opens the full raw activity inspector. */
  onOpenInspector: () => void;
  projectId: string;
}) {
  const activity = useQuery(conversationQueries.activity(projectId, conversationId));
  const status = useQuery(projectQueries.status(projectId));

  const entries = activity.data?.entries ?? [];
  // The rail describes the most recent turn, which is the one the reader is
  // watching; earlier turns stay in the full inspector.
  const latestTaskId = entries.at(-1)?.taskId;
  const stages = latestTaskId ? entries.filter((entry) => entry.taskId === latestTaskId) : [];

  return (
    <aside aria-label="Live work" className="morrow-conversation-rail">
      <div className="morrow-conversation-rail__head">
        <b>Live work</b>
        <span
          aria-live="polite"
          className="morrow-conversation-rail__live"
          data-state={active ? "active" : "idle"}
        >
          {active ? "Active" : "Idle"}
        </span>
      </div>

      {activity.isPending ? (
        <p className="morrow-conversation-rail__empty" role="status">
          Loading activity…
        </p>
      ) : activity.isError ? (
        <p className="morrow-conversation-rail__empty" role="status">
          Activity is unavailable right now. The conversation is unaffected.
        </p>
      ) : stages.length === 0 ? (
        <p className="morrow-conversation-rail__empty">
          Steps appear here as Morrow works.
        </p>
      ) : (
        stages.map((stage) => <RailStage entry={stage} key={stage.id} />)
      )}

      <div className="morrow-conversation-rail__context">
        <p className="morrow-product-eyebrow">Run context</p>
        <h3>{status.data?.name ?? "This project"}</h3>
        <p>
          {status.data?.accessible === false
            ? "Workspace is not accessible right now"
            : "Local project · work stays on this machine"}
        </p>
        <div className="morrow-conversation-rail__metrics">
          <div className="morrow-conversation-rail__metric">
            <b>{stages.length}</b>
            <span>steps this turn</span>
          </div>
          <div className="morrow-conversation-rail__metric">
            <b>{status.data?.gitDetected ? status.data.branch ?? "detached" : "—"}</b>
            <span>branch</span>
          </div>
        </div>
        <button className="morrow-conversation-rail__inspect" onClick={onOpenInspector} type="button">
          Open full activity ↗
        </button>
      </div>
    </aside>
  );
}

function RailStage({ entry }: { entry: WebConversationActivityEntry }) {
  return (
    <div className="morrow-conversation-rail__stage" data-state={entry.status ?? "done"}>
      <span aria-hidden="true" className="morrow-conversation-rail__node" />
      <b>{entry.summary}</b>
      {entry.detail ? <p>{entry.detail}</p> : null}
      <time>{stageStatusLabel(entry)}</time>
    </div>
  );
}

/**
 * Honest state language: a step that failed says so, a queued step is not
 * described as finished, and an unknown status is not upgraded to success.
 */
function stageStatusLabel(entry: WebConversationActivityEntry): string {
  switch (entry.status) {
    case "running":
      return "Running now";
    case "failed":
      return "Failed";
    case "blocked":
      return "Needs attention";
    case "pending":
      return "Queued";
    case "completed":
      return entry.durationMs !== null
        ? `Completed · ${entry.durationMs.toLocaleString("en-US")} ms`
        : "Completed";
    default:
      return "Recorded";
  }
}
