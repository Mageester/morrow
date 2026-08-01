import type { WebConversationActivityEntry } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { Brain, ChevronRight, FileCode2, Terminal, Wrench, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { conversationQueries } from "../../api/conversations.js";
import { Markdown } from "../../components/markdown.js";

function activityIcon(kind: WebConversationActivityEntry["kind"]) {
  if (kind === "assistant") return <Brain aria-hidden="true" size={15} />;
  if (kind === "file" || kind === "diff") return <FileCode2 aria-hidden="true" size={15} />;
  if (kind === "command" || kind === "process") return <Terminal aria-hidden="true" size={15} />;
  return <Wrench aria-hidden="true" size={15} />;
}

function activityMeta(item: WebConversationActivityEntry): string | null {
  if (item.kind === "assistant") return item.detail;
  if (item.status === "failed" || item.status === "blocked") return "Needs attention";
  if (item.status === "running") return "Working";
  return item.toolName?.replaceAll("_", " ") ?? null;
}

export function ActivityDetails({ item }: { item: WebConversationActivityEntry }) {
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
      </dl>
    </div>
  );
}

export function ActivityTimeline({
  entries,
  label = "Activity timeline",
}: {
  entries: readonly WebConversationActivityEntry[];
  label?: string;
}) {
  return (
    <ol aria-label={label} className="morrow-activity-timeline">
      {entries.map((item) => (
        <li data-kind={item.kind} data-status={item.status} key={item.id}>
          <details>
            <summary>
              <span className="morrow-activity-entry__icon">{activityIcon(item.kind)}</span>
              <span className="morrow-activity-entry__main">
                <span className="morrow-activity-entry__summary">{item.summary}</span>
                {activityMeta(item) ? <span className="morrow-activity-entry__meta">{activityMeta(item)}</span> : null}
              </span>
              <ChevronRight aria-hidden="true" className="morrow-activity-entry__chevron" size={15} />
            </summary>
            <ActivityDetails item={item} />
          </details>
        </li>
      ))}
    </ol>
  );
}

/** Claude-style execution rail placed directly beside the response it produced.
 * Browser-visible data remains the same redacted, allow-listed projection used
 * by the full inspector. */
export function ConversationActivity({ entries }: { entries: readonly WebConversationActivityEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section aria-label="Morrow activity" className="morrow-conversation-activity">
      <ActivityTimeline entries={entries} label="Morrow activity" />
    </section>
  );
}

/**
 * The interleaved transcript: one chronological stream of what Morrow said and
 * what it did, in the order it happened. Narration entries render as the
 * assistant's own prose; every other entry renders as a collapsible step. This
 * is the whole point of the projection carrying `sequence` — reading top to
 * bottom reproduces the run, rather than showing a block of tools above a block
 * of text with no way to tell which words preceded which action.
 */
export function ConversationTranscript({
  entries,
  streaming = false,
}: {
  entries: readonly WebConversationActivityEntry[];
  streaming?: boolean;
}) {
  if (entries.length === 0) return null;
  const lastNarrationId = [...entries].reverse().find((item) => item.kind === "narration")?.id ?? null;
  return (
    <div className="morrow-transcript" data-testid="conversation-transcript">
      {entries.map((item) => {
        if (item.kind === "narration") {
          return (
            <div className="morrow-transcript__say" data-testid="transcript-narration" key={item.id}>
              <Markdown streaming={streaming && item.id === lastNarrationId} text={item.text ?? ""} />
            </div>
          );
        }
        return (
          <div className="morrow-transcript__do" key={item.id}>
            <ActivityTimeline entries={[item]} label={item.summary} />
          </div>
        );
      })}
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
      {activity.data && activity.data.entries.length > 0 ? <ActivityTimeline entries={activity.data.entries} /> : null}
    </aside>
  );
}
