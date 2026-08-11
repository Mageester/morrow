import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { researchSourceQueries } from "../../api/research-sources.js";

function retrievedLabel(value: string): string {
  return `Retrieved ${new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}

function publishedLabel(value: string | null): string {
  return value ? `Published ${new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : "Publication date unknown";
}

export interface SourcePanelProps {
  taskId: string;
}

export function SourcePanel({ taskId }: SourcePanelProps) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const query = useQuery({ ...researchSourceQueries.forTask(taskId), enabled: Boolean(taskId) });
  const sources = query.data?.sources ?? [];

  useEffect(() => setOpen(false), [taskId]);

  return (
    <section aria-label="Research sources" className="morrow-source-panel">
      <div className="morrow-source-panel__header">
        <div>
          <p className="morrow-source-panel__eyebrow">Research provenance</p>
          <p>{sources.length} {sources.length === 1 ? "source" : "sources"}</p>
        </div>
        <button
          aria-controls={detailsId}
          aria-expanded={open}
          className="morrow-source-panel__toggle"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {open ? "Hide sources" : "Show sources"}
        </button>
      </div>

      {!open && sources.length === 0 ? <p>No research sources recorded.</p> : null}

      {open ? (
        <div id={detailsId} className="morrow-source-panel__details">
          {sources.length === 0 ? <p>No research sources recorded.</p> : null}
          {sources.map((source) => (
            <article key={source.id} className="morrow-source-panel__source">
              <h3>{source.title || source.url}</h3>
              <p>{source.publisher || "Publisher unknown"}</p>
              <p>{publishedLabel(source.publishedAt)} · {retrievedLabel(source.retrievedAt)}</p>
              <p>Source status: {source.validationStatus}</p>
              <p>Untrusted fetched content; recency does not establish authority.</p>
              <a href={source.url} rel="noreferrer" target="_blank">Open source</a>
              {source.citations.length > 0 ? (
                <ul>
                  {source.citations.map((citation, index) => (
                    <li key={`${source.id}-${index}`}>
                      <p>Claim: {citation.claim}</p>
                      <p>Cited excerpt: {citation.excerpt}</p>
                    </li>
                  ))}
                </ul>
              ) : <p>No bounded citations recorded.</p>}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
