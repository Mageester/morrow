import type { WebConversationActivityEntry } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { conversationQueries } from "../../api/conversations.js";

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function formatKind(kind: WebConversationActivityEntry["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function ActivityDetails({ item }: { item: WebConversationActivityEntry }) {
  return (
    <div className="morrow-activity-entry__details">
      {item.detail ? <p>{item.detail}</p> : null}
      {item.target ? (
        <div className="morrow-activity-entry__target">
          <span>Target</span>
          <code>{item.target}</code>
        </div>
      ) : null}
      <dl>
        {item.toolName ? <div><dt>Tool</dt><dd>{item.toolName.replaceAll("_", " ")}</dd></div> : null}
        {item.durationMs !== null ? <div><dt>Duration</dt><dd>{item.durationMs.toLocaleString("en-US")} ms</dd></div> : null}
        {item.exitCode !== null ? <div><dt>Exit status</dt><dd>Exit {item.exitCode}</dd></div> : null}
        {item.resultCount !== null ? <div><dt>Results</dt><dd>{item.resultCount.toLocaleString("en-US")}</dd></div> : null}
        <div><dt>Recorded</dt><dd><time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></dd></div>
      </dl>
    </div>
  );
}

export interface ActivityPanelProps {
  conversationId: string;
  onClose: () => void;
  projectId: string;
}

export function ActivityPanel({ conversationId, onClose, projectId }: ActivityPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const activity = useQuery(conversationQueries.activity(projectId, conversationId));

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <aside
      aria-label="Activity / Inspect"
      className="morrow-activity-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="morrow-activity-panel__header">
        <div>
          <p className="morrow-eyebrow">Saved execution history</p>
          <h2>Activity / Inspect</h2>
        </div>
        <button
          aria-label="Close Activity / Inspect"
          onClick={onClose}
          ref={closeRef}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>

      <p className="morrow-activity-panel__contract">
        Completed events remain in this saved history. Sensitive arguments, private model reasoning, and raw provider output stay server-side.
      </p>

      {activity.isPending ? <p aria-live="polite" role="status">Loading saved activity…</p> : null}
      {activity.isError && !activity.data ? (
        <div className="morrow-activity-panel__error">
          <p role="alert">Saved activity could not be loaded. Mission progress remains safe.</p>
          <button onClick={() => { void activity.refetch(); }} type="button">Try again</button>
        </div>
      ) : null}
      {activity.data?.entries.length === 0 ? (
        <p className="morrow-activity-panel__empty">Work events will appear here after Morrow starts this conversation.</p>
      ) : null}
      {activity.data && activity.data.entries.length > 0 ? (
        <ol aria-label="Activity timeline" className="morrow-activity-timeline">
          {activity.data.entries.map((item) => (
            <li data-kind={item.kind} data-status={item.status} key={item.id}>
              <details>
                <summary>
                  <span className="morrow-activity-entry__marker" />
                  <span className="morrow-activity-entry__main">
                    <span className="morrow-activity-entry__summary">{item.summary}</span>
                    <span className="morrow-activity-entry__meta">
                      {formatKind(item.kind)} · {item.status}
                    </span>
                  </span>
                  <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
                </summary>
                <ActivityDetails item={item} />
              </details>
            </li>
          ))}
        </ol>
      ) : null}
    </aside>
  );
}
