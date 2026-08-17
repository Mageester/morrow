import type { WebConversationActivityEntry } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  FileCode2,
  Filter,
  Layers,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { conversationQueries } from "../../api/conversations.js";
import { Markdown } from "../../components/markdown.js";

export type ActivityFilterCategory =
  | "all"
  | "tools"
  | "files"
  | "commands"
  | "provider"
  | "context"
  | "system";

/** Shared between the drawer's timeline and the conversation's work summary,
 * so the same kind of event never wears two different icons. */
export function activityIcon(kind: WebConversationActivityEntry["kind"]) {
  if (kind === "assistant") return <Brain aria-hidden="true" size={14} />;
  if (kind === "memory") return <Sparkles aria-hidden="true" size={14} />;
  if (kind === "file" || kind === "diff") return <FileCode2 aria-hidden="true" size={14} />;
  if (kind === "command" || kind === "process") return <Terminal aria-hidden="true" size={14} />;
  if (kind === "provider") return <Cpu aria-hidden="true" size={14} />;
  if (kind === "context") return <Layers aria-hidden="true" size={14} />;
  return <Wrench aria-hidden="true" size={14} />;
}

function activityMeta(item: WebConversationActivityEntry): string | null {
  if (item.kind === "assistant") return item.detail;
  if (item.status === "failed") return "Failed";
  if (item.status === "blocked") return "Needs attention";
  if (item.status === "running") return "Working…";
  if (item.durationMs !== null) {
    return item.durationMs >= 1000
      ? `${(item.durationMs / 1000).toFixed(1)}s`
      : `${item.durationMs}ms`;
  }
  return item.toolName?.replaceAll("_", " ") ?? null;
}

export const ActivityDetails = memo(function ActivityDetails({ item }: { item: WebConversationActivityEntry }) {
  const [copied, setCopied] = useState(false);

  const copyTarget = () => {
    if (!item.target) return;
    void navigator.clipboard.writeText(item.target);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="morrow-activity-entry__details">
      {item.detail ? <p className="morrow-activity-entry__detail-text">{item.detail}</p> : null}
      {item.target ? (
        <div className="morrow-activity-entry__target">
          <span>Target</span>
          <div className="morrow-activity-entry__target-row">
            <code>{item.target}</code>
            <button
              aria-label="Copy target"
              className="morrow-activity-entry__copy"
              onClick={copyTarget}
              title="Copy target"
              type="button"
            >
              {copied ? <Check aria-hidden="true" size={12} /> : <Copy aria-hidden="true" size={12} />}
            </button>
          </div>
        </div>
      ) : null}
      <dl>
        {item.toolName ? (
          <div>
            <dt>Tool</dt>
            <dd>{item.toolName.replaceAll("_", " ")}</dd>
          </div>
        ) : null}
        {item.durationMs !== null ? (
          <div>
            <dt>Duration</dt>
            <dd>{item.durationMs.toLocaleString("en-US")} ms</dd>
          </div>
        ) : null}
        {item.exitCode !== null ? (
          <div>
            <dt>Exit status</dt>
            <dd>Exit {item.exitCode}</dd>
          </div>
        ) : null}
        {item.resultCount !== null ? (
          <div>
            <dt>Results</dt>
            <dd>{item.resultCount.toLocaleString("en-US")}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
});

export const ActivityTimelineItem = memo(function ActivityTimelineItem({
  item,
  forcedOpen,
}: {
  item: WebConversationActivityEntry;
  forcedOpen?: boolean | undefined;
}) {
  const meta = activityMeta(item);
  return (
    <li data-kind={item.kind} data-status={item.status} key={item.id}>
      <details open={forcedOpen !== undefined ? forcedOpen : undefined}>
        <summary>
          <span className="morrow-activity-entry__icon">{activityIcon(item.kind)}</span>
          <span className="morrow-activity-entry__main">
            <span className="morrow-activity-entry__summary">{item.summary}</span>
            {meta ? <span className="morrow-activity-entry__meta">{meta}</span> : null}
          </span>
          <ChevronRight aria-hidden="true" className="morrow-activity-entry__chevron" size={14} />
        </summary>
        <ActivityDetails item={item} />
      </details>
    </li>
  );
});

export function ActivityTimeline({
  entries,
  label = "Activity timeline",
  forcedOpen,
}: {
  entries: readonly WebConversationActivityEntry[];
  label?: string;
  forcedOpen?: boolean | undefined;
}) {
  return (
    <ol aria-label={label} className="morrow-activity-timeline">
      {entries.map((item) => (
        <ActivityTimelineItem forcedOpen={forcedOpen} item={item} key={item.id} />
      ))}
    </ol>
  );
}

/**
 * Compact execution step row for inline transcript.
 * Click to expand full details/target/output.
 */
export const CompactTranscriptTool = memo(function CompactTranscriptTool({ entry }: { entry: WebConversationActivityEntry }) {
  const [open, setOpen] = useState(false);
  const duration = entry.durationMs !== null ? `${entry.durationMs}ms` : null;

  return (
    <div
      className={`morrow-transcript-tool morrow-transcript-tool--${entry.status}`}
      data-kind={entry.kind}
      data-status={entry.status}
    >
      <button
        aria-expanded={open}
        className="morrow-transcript-tool__header"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <span className="morrow-transcript-tool__indicator" aria-hidden="true">
          {entry.status === "completed" ? (
            <span className="morrow-transcript-tool__check">✓</span>
          ) : entry.status === "failed" ? (
            <span className="morrow-transcript-tool__error">✕</span>
          ) : entry.status === "running" ? (
            <span className="morrow-transcript-tool__spinner" />
          ) : (
            <span className="morrow-transcript-tool__dot" />
          )}
        </span>
        <span className="morrow-transcript-tool__icon">{activityIcon(entry.kind)}</span>
        <span className="morrow-transcript-tool__summary">{entry.summary}</span>
        {duration ? <span className="morrow-transcript-tool__duration">{duration}</span> : null}
        {entry.exitCode !== null ? (
          <span className={`morrow-transcript-tool__exit morrow-transcript-tool__exit--${entry.exitCode === 0 ? "ok" : "err"}`}>
            exit {entry.exitCode}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={`morrow-transcript-tool__chevron${open ? " is-open" : ""}`}
          size={13}
        />
      </button>
      {open ? (
        <div className="morrow-transcript-tool__body">
          <ActivityDetails item={entry} />
        </div>
      ) : null}
    </div>
  );
});

const ConversationTranscriptItem = memo(function ConversationTranscriptItem({
  item,
  isStreamingNarration,
}: {
  item: WebConversationActivityEntry;
  isStreamingNarration: boolean;
}) {
  if (item.kind === "narration") {
    return (
      <div className="morrow-transcript__say" data-testid="transcript-narration">
        <Markdown streaming={isStreamingNarration} text={item.text ?? ""} />
      </div>
    );
  }
  return (
    <div className="morrow-transcript__do">
      <ActivityTimeline entries={[item]} label={item.summary} />
    </div>
  );
});

/**
 * Interleaved transcript: one chronological stream of what Morrow said and what it did.
 * Assistant prose is primary. Tool work appears as compact inline steps.
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
      {entries.map((item) => (
        <ConversationTranscriptItem
          isStreamingNarration={streaming && item.id === lastNarrationId}
          item={item}
          key={item.id}
        />
      ))}
    </div>
  );
}

export function ConversationActivity({ entries }: { entries: readonly WebConversationActivityEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section aria-label="Morrow activity" className="morrow-conversation-activity">
      <ActivityTimeline entries={entries} label="Morrow activity" />
    </section>
  );
}

export interface ActivityPanelProps {
  conversationId: string;
  onClose: () => void;
  projectId: string;
}

function matchesFilter(item: WebConversationActivityEntry, filter: ActivityFilterCategory): boolean {
  if (filter === "all") return true;
  if (filter === "tools") {
    return ["tool", "command", "file", "diff", "search", "process"].includes(item.kind);
  }
  if (filter === "files") {
    return item.kind === "file" || item.kind === "diff";
  }
  if (filter === "commands") {
    return item.kind === "command" || item.kind === "process";
  }
  if (filter === "provider") {
    return item.kind === "provider";
  }
  if (filter === "context") {
    return item.kind === "context";
  }
  if (filter === "system") {
    return ["system", "approval", "recovery", "memory", "assistant"].includes(item.kind);
  }
  return true;
}

export function ActivityPanel({ conversationId, onClose, projectId }: ActivityPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const activity = useQuery(conversationQueries.activity(projectId, conversationId));
  const [filter, setFilter] = useState<ActivityFilterCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandAll, setExpandAll] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const allEntries = activity.data?.entries ?? [];

  const counts = useMemo(() => {
    const map: Record<ActivityFilterCategory, number> = {
      all: allEntries.length,
      tools: 0,
      files: 0,
      commands: 0,
      provider: 0,
      context: 0,
      system: 0,
    };
    for (const item of allEntries) {
      if (["tool", "command", "file", "diff", "search", "process"].includes(item.kind)) map.tools += 1;
      if (item.kind === "file" || item.kind === "diff") map.files += 1;
      if (item.kind === "command" || item.kind === "process") map.commands += 1;
      if (item.kind === "provider") map.provider += 1;
      if (item.kind === "context") map.context += 1;
      if (["system", "approval", "recovery", "memory", "assistant"].includes(item.kind)) map.system += 1;
    }
    return map;
  }, [allEntries]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return allEntries.filter((item) => {
      if (!matchesFilter(item, filter)) return false;
      if (!query) return true;
      const text = `${item.summary} ${item.detail ?? ""} ${item.target ?? ""} ${item.toolName ?? ""}`.toLowerCase();
      return text.includes(query);
    });
  }, [allEntries, filter, searchQuery]);

  const CATEGORIES: Array<{ id: ActivityFilterCategory; label: string }> = [
    { id: "all", label: "All" },
    { id: "tools", label: "Tools" },
    { id: "files", label: "Files" },
    { id: "commands", label: "Commands" },
    { id: "provider", label: "Provider" },
    { id: "context", label: "Context" },
    { id: "system", label: "System" },
  ];

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
      ref={panelRef}
    >
      <header className="morrow-activity-panel__header">
        <div>
          <p className="morrow-eyebrow">Execution ledger</p>
          <h2>Activity / Inspect</h2>
        </div>
        <button
          aria-label="Close Activity / Inspect"
          className="morrow-activity-panel__close"
          onClick={onClose}
          ref={closeRef}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </header>

      <div className="morrow-activity-panel__controls">
        <div className="morrow-activity-panel__search-box">
          <Search aria-hidden="true" className="morrow-activity-panel__search-icon" size={13} />
          <input
            aria-label="Search activity"
            className="morrow-activity-panel__search"
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search activity events, files, commands…"
            type="search"
            value={searchQuery}
          />
          {searchQuery ? (
            <button
              aria-label="Clear search"
              className="morrow-activity-panel__search-clear"
              onClick={() => setSearchQuery("")}
              type="button"
            >
              <X aria-hidden="true" size={12} />
            </button>
          ) : null}
        </div>

        <div aria-label="Filter activity category" className="morrow-activity-panel__tabs" role="tablist">
          {CATEGORIES.map((cat) => (
            <button
              aria-selected={filter === cat.id}
              className={`morrow-activity-panel__tab${filter === cat.id ? " is-active" : ""}`}
              key={cat.id}
              onClick={() => setFilter(cat.id)}
              role="tab"
              type="button"
            >
              <span>{cat.label}</span>
              <span className="morrow-activity-panel__count">{counts[cat.id]}</span>
            </button>
          ))}
        </div>

        <div className="morrow-activity-panel__actions">
          <span className="morrow-activity-panel__matched-count">
            {filteredEntries.length} event{filteredEntries.length === 1 ? "" : "s"}
          </span>
          <button
            className="morrow-activity-panel__toggle-all"
            onClick={() => setExpandAll((prev) => (prev ? false : true))}
            type="button"
          >
            {expandAll ? "Collapse all" : "Expand all"}
          </button>
        </div>
      </div>

      <div className="morrow-activity-panel__content">
        {activity.isPending ? (
          <p aria-live="polite" className="morrow-activity-panel__status" role="status">
            Loading execution activity…
          </p>
        ) : null}
        {activity.isError && !activity.data ? (
          <div className="morrow-activity-panel__error">
            <p role="alert">Saved activity could not be loaded. Task progress remains safe.</p>
            <button onClick={() => { void activity.refetch(); }} type="button">
              Try again
            </button>
          </div>
        ) : null}
        {!activity.isPending && allEntries.length === 0 ? (
          <p className="morrow-activity-panel__empty">Work events will appear here as Morrow runs tasks.</p>
        ) : null}
        {!activity.isPending && allEntries.length > 0 && filteredEntries.length === 0 ? (
          <p className="morrow-activity-panel__empty">No events match the selected filter.</p>
        ) : null}
        {filteredEntries.length > 0 ? (
          <ActivityTimeline entries={filteredEntries} forcedOpen={expandAll} label="Filtered activity timeline" />
        ) : null}
      </div>

      <footer className="morrow-activity-panel__footer">
        <p>Completed events remain in this saved history. Sensitive arguments and private model reasoning stay server-side.</p>
      </footer>
    </aside>
  );
}
