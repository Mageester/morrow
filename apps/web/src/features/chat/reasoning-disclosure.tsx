import { useQuery } from "@tanstack/react-query";
import { conversationQueries } from "../../api/conversations.js";

export interface ReasoningDisclosureProps {
  active: boolean;
  conversationId: string;
  projectId: string;
  taskId: string;
}

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
      ) : reasoning.data.entries.length === 0 ? (
        <p className="morrow-reasoning__status">
          {active ? "Waiting for provider reasoning…" : "This provider did not expose reasoning for this response."}
        </p>
      ) : (
        <div className="morrow-reasoning__entries">
          {reasoning.data.entries.map((entry) => (
            <article key={entry.turnKey}>
              <p className="morrow-reasoning__provider">{entry.providerId}</p>
              <pre>{entry.content}</pre>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
