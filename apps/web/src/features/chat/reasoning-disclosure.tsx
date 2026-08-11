import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { conversationQueries } from "../../api/conversations.js";

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

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [openEntries, setOpenEntries] = useState<Set<string>>(() => new Set());

  const sortedEntries = useMemo(
    () => reasoning.data?.entries
      ? [...reasoning.data.entries].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      : [],
    [reasoning.data?.entries],
  );
  const latestEntry = sortedEntries.at(-1);
  const latestKey = latestEntry?.turnKey;
  const latestContent = latestEntry?.content;

  useEffect(() => {
    if (!latestKey) return;
    setOpenEntries((current) => {
      if (current.has(latestKey)) return current;
      const next = new Set(current);
      next.add(latestKey);
      return next;
    });
  }, [latestKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !latestKey || !followLatestRef.current) return;
    const frame = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [latestContent, latestKey, sortedEntries.length]);

  function toggleEntry(turnKey: string) {
    setOpenEntries((current) => {
      const next = new Set(current);
      if (next.has(turnKey)) next.delete(turnKey);
      else next.add(turnKey);
      return next;
    });
  }

  function handleScroll() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nearBottom = isNearBottom(viewport);
    followLatestRef.current = nearBottom;
    setJumpVisible(!nearBottom && Boolean(latestKey));
  }

  function jumpToLatest() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followLatestRef.current = true;
    setJumpVisible(false);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }

  return (
    <section aria-label="Model reasoning" className="morrow-reasoning" role="region">
      <header className="morrow-reasoning__header">
        <div className="morrow-reasoning__title">
          <p>Model reasoning</p>
          <span>Provider-supplied</span>
        </div>
        <div className="morrow-reasoning__summary">
          {sortedEntries.length > 0 ? <span>{sortedEntries.length} step{sortedEntries.length === 1 ? "" : "s"}</span> : null}
          {active ? <span aria-live="polite" className="morrow-reasoning__status">Streaming</span> : null}
        </div>
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
        <>
          <div
            aria-label="Reasoning steps"
            className="morrow-reasoning__viewport"
            onScroll={handleScroll}
            ref={viewportRef}
          >
            <div className="morrow-reasoning__entries">
              {sortedEntries.map((entry, index) => {
                const time = timeFormatter.format(new Date(entry.createdAt));
                const open = openEntries.has(entry.turnKey);
                const isLast = index === sortedEntries.length - 1;
                return (
                  <article
                    className={`morrow-reasoning__entry${open ? " is-open" : ""}${isLast ? " is-latest" : ""}`}
                    data-latest={isLast ? "true" : "false"}
                    data-open={open ? "true" : "false"}
                    data-streaming={active && isLast ? "true" : "false"}
                    key={entry.turnKey}
                  >
                    <button
                      aria-expanded={open}
                      className="morrow-reasoning__entry-trigger"
                      onClick={() => toggleEntry(entry.turnKey)}
                      type="button"
                    >
                      <span className="morrow-reasoning__entry-marker" aria-hidden="true" />
                      <span className="morrow-reasoning__turn-label">Step {index + 1}</span>
                      <time className="morrow-reasoning__time" dateTime={entry.createdAt}>{time}</time>
                      <span className="morrow-reasoning__entry-action" aria-hidden="true">{open ? "Hide" : "Show"}</span>
                    </button>
                    <div aria-hidden={!open} className="morrow-reasoning__content-shell">
                      <div className="morrow-reasoning__content">
                        <Markdown remarkPlugins={[remarkGfm]}>{entry.content}</Markdown>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
          {jumpVisible ? (
            <button className="morrow-reasoning__jump" onClick={jumpToLatest} type="button">
              Jump to latest
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
