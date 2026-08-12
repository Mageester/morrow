import type { SearchHit } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Brain, Cable, Clock3, Folder, Search, Settings, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { projectQueries } from "../../api/projects.js";
import { searchQueries } from "../../api/search.js";

const destinations = [
  { label: "Projects", description: "Choose or manage a local workspace", to: "/projects", icon: Folder },
  { label: "Skills", description: "See installed and learned workflows", to: "/skills", icon: WandSparkles },
  { label: "Memory", description: "Review what Morrow remembers", to: "/memory", icon: Brain },
  { label: "History", description: "Return to a past conversation", to: "/chats", icon: Clock3 },
  { label: "Connections", description: "Connect a model provider", to: "/connections", icon: Cable },
  { label: "Settings", description: "Appearance, privacy, and assistant controls", to: "/settings", icon: Settings },
] as const;

function resultLabel(hit: SearchHit): string {
  if (hit.kind === "message") return hit.title === "assistant" ? "Morrow message" : "Your message";
  return hit.kind[0]!.toUpperCase() + hit.kind.slice(1);
}

function SearchResultLink({ hit, projectName, onNavigate }: { hit: SearchHit; projectName: string; onNavigate: () => void }) {
  const cleanSnippet = hit.snippet.replaceAll("[", "").replaceAll("]", "");
  const primary = hit.kind === "message" || hit.kind === "memory" ? cleanSnippet : hit.title || cleanSnippet;
  const content = (
    <>
      <span className="morrow-command__result-meta">{resultLabel(hit)} · {projectName}</span>
      <strong>{primary}</strong>
      {hit.kind !== "message" && hit.kind !== "memory" && cleanSnippet !== hit.title ? (
        <span className="morrow-command__result-snippet">{cleanSnippet}</span>
      ) : null}
    </>
  );

  if (hit.conversationId) {
    return (
      <Link className="morrow-command__result" onClick={onNavigate} params={{ conversationId: hit.conversationId }} search={{ projectId: hit.projectId }} to="/chats/$conversationId">
        {content}
      </Link>
    );
  }
  if (hit.kind === "memory") {
    return <Link className="morrow-command__result" onClick={onNavigate} to="/memory">{content}</Link>;
  }
  return <Link className="morrow-command__result" onClick={onNavigate} to="/missions">{content}</Link>;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const search = useQuery(searchQueries.global(query));
  const projects = useQuery(projectQueries.list());
  const projectNames = useMemo(
    () => new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );
  const visibleDestinations = destinations.filter((item) =>
    normalized.length === 0 || `${item.label} ${item.description}`.toLowerCase().includes(normalized),
  );
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button className="morrow-command__trigger" onClick={() => setOpen(true)} type="button">
        <Search aria-hidden="true" size={16} />
        <span>Search</span>
        <kbd>Ctrl K</kbd>
      </button>
      {open ? createPortal((
        <div className="morrow-command__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <section aria-label="Search Morrow" aria-modal="true" className="morrow-command" role="dialog">
            <div className="morrow-command__input-wrap">
              <Search aria-hidden="true" size={19} />
              <input
                aria-label="Search Morrow"
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search conversations, tasks, memory, and pages"
                role="searchbox"
                value={query}
              />
              <button aria-label="Close search" onClick={close} type="button"><X aria-hidden="true" size={18} /></button>
            </div>
            <div className="morrow-command__results">
              {visibleDestinations.length > 0 ? (
                <div className="morrow-command__group">
                  <p>Go to</p>
                  {visibleDestinations.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link className="morrow-command__destination" key={item.to} onClick={close} to={item.to}>
                        <Icon aria-hidden="true" size={17} />
                        <span><strong>{item.label}</strong><small>{item.description}</small></span>
                      </Link>
                    );
                  })}
                </div>
              ) : null}
              {normalized.length >= 2 ? (
                <div className="morrow-command__group">
                  <p>Across your projects</p>
                  {search.isPending ? <span className="morrow-command__state" role="status">Searching…</span> : null}
                  {search.isError ? <span className="morrow-command__state" role="alert">Search is unavailable right now.</span> : null}
                  {(search.data?.hits ?? []).map((hit) => (
                    <SearchResultLink hit={hit} key={`${hit.kind}:${hit.refId}`} onNavigate={close} projectName={projectNames.get(hit.projectId) ?? "Local project"} />
                  ))}
                  {search.data && search.data.hits.length === 0 ? <span className="morrow-command__state">No matching history or memory.</span> : null}
                </div>
              ) : null}
            </div>
            <footer className="morrow-command__footer">Search stays on this Morrow install.</footer>
          </section>
        </div>
      ), document.body) : null}
    </>
  );
}
