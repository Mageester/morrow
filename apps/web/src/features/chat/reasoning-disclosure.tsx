import { useQuery } from "@tanstack/react-query";
import { conversationQueries } from "../../api/conversations.js";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface ReasoningDisclosureProps {
  active: boolean;
  conversationId: string;
  projectId: string;
  taskId: string;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** Opt-in projection of reasoning text explicitly supplied by the provider.
 * The component is mounted only while the chat-level toggle is enabled, so an
 * ordinary conversation view performs no reasoning request. */
export function ReasoningDisclosure({
  active,
  conversationId,
  projectId,
  taskId,
}: ReasoningDisclosureProps) {
  const reasoning = useQuery({
    ...conversationQueries.reasoning(projectId, conversationId, taskId),
    refetchInterval: active ? 1_000 : false,
  });

  const sortedEntries = reasoning.data?.entries
    ? [...reasoning.data.entries].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    : [];

  return (
    <section aria-label="Model reasoning" className="morrow-reasoning" role="region">
      <header className="morrow-reasoning__header">
        <p>Model reasoning</p>
        <span>Provider-supplied</span>
      </header>
      {reasoning.isPending ? (
        <p className="morrow-reasoning__status">Loading reasoning…</p>
      ) : reasoning.isError ? (
        <p className="morrow-reasoning__status" role="status">Reasoning is unavailable right now.</p>
      ) : sortedEntries.length === 0 ? (
        <p className="morrow-reasoning__status">
          {active ? "Waiting for provider reasoning…" : "This provider did not expose reasoning for this response."}
        </p>
      ) : (
        <div className="morrow-reasoning__entries">
          {sortedEntries.map((entry, index) => {
            const time = timeFormatter.format(new Date(entry.createdAt));
            const isLast = index === sortedEntries.length - 1;
            return (
              <details key={entry.turnKey} className="morrow-reasoning__entry-details" open={isLast ? true : undefined}>
                <summary className="morrow-reasoning__entry-summary">
                  <div className="morrow-reasoning__turn-info">
                    <span className="morrow-reasoning__turn-label">Turn {index + 1}</span>
                    <span className="morrow-reasoning__provider">{entry.providerId}</span>
                  </div>
                  <div className="morrow-reasoning__turn-meta">
                    <span className="morrow-reasoning__time">{time}</span>
                    <span className="morrow-reasoning__summary-hint">Click to toggle reasoning</span>
                  </div>
                </summary>
                <div className="morrow-reasoning__content">
                  <Markdown remarkPlugins={[remarkGfm]}>{entry.content}</Markdown>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
