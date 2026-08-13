import type { Conversation } from "@morrow/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { conversationQueries } from "../../api/conversations.js";
import { ProductHeader } from "../../components/product-frame.js";
import { useActiveProject } from "../projects/use-active-project.js";

type ChatsTab = "active" | "archived";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start - target) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return formatDate(iso);
}

export function ChatsPage() {
  const projects = useActiveProject();
  const activeProject = projects.activeProject;
  const [tab, setTab] = useState<ChatsTab>("active");
  const [query, setQuery] = useState("");
  const includeArchived = tab === "archived";
  const conversations = useQuery({
    ...conversationQueries.list(activeProject?.id ?? "", includeArchived),
    enabled: Boolean(activeProject),
  });

  return (
    <section aria-labelledby="chats-heading" className="morrow-page morrow-chats">
      <ProductHeader
        action={activeProject ? (
          <label className="morrow-premium-search">
            <Search aria-hidden="true" size={15} />
            <span className="morrow-visually-hidden">Search history</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search conversations and results…"
              type="search"
              value={query}
            />
          </label>
        ) : undefined}
        description="Outcomes, decisions, and unfinished work—remembered in context."
        eyebrow="Your chronicle"
        headingId="chats-heading"
        title="History"
      />

      {projects.isPending ? (
        <p aria-live="polite" role="status">Loading your projects…</p>
      ) : projects.isError ? (
        <div className="morrow-inline-error">
          <p role="alert">Your projects could not be loaded.</p>
          <button onClick={() => void projects.refetch()} type="button">Try again</button>
        </div>
      ) : projects.needsSelection ? (
        <div className="morrow-empty">
          <h2>{projects.staleSelection ? "Your project selection needs a refresh" : "Select a project"}</h2>
          <p>{projects.staleSelection ? "The project Morrow last used here is no longer available." : "Choose which local project Morrow should work in."}</p>
          <Link className="morrow-empty__action" to="/projects">Go to Projects</Link>
        </div>
      ) : !activeProject ? (
        <div className="morrow-empty">
          <h2>No local project yet</h2>
          <p>Create a local project and your conversations will collect here.</p>
          <Link className="morrow-empty__action" to="/projects">Add a project</Link>
        </div>
      ) : (
        <>
          <div aria-label="Filter history" className="morrow-history-controls" role="group">
            <button aria-pressed={tab === "active"} className="morrow-chats__tab" onClick={() => setTab("active")} type="button">Active</button>
            <button aria-pressed={tab === "archived"} className="morrow-chats__tab" onClick={() => setTab("archived")} type="button">Archived</button>
          </div>
          <ChatList
            conversations={conversations}
            includeArchived={includeArchived}
            projectId={activeProject.id}
            projectName={activeProject.name}
            query={query}
          />
        </>
      )}
    </section>
  );
}

function ChatList({
  conversations,
  includeArchived,
  projectId,
  projectName,
  query,
}: {
  conversations: UseQueryResult<Conversation[], Error>;
  includeArchived: boolean;
  projectId: string;
  projectName: string;
  query: string;
}) {
  if (conversations.isPending) return <p aria-live="polite" role="status">Loading your chats…</p>;
  if (conversations.isError) {
    return (
      <div className="morrow-inline-error">
        <p role="alert">Your chats could not be loaded.</p>
        <button onClick={() => void conversations.refetch()} type="button">Try again</button>
      </div>
    );
  }

  const rows = (conversations.data ?? []).filter((conversation) => (
    (includeArchived ? conversation.archived : !conversation.archived)
    && conversation.title.toLowerCase().includes(query.trim().toLowerCase())
  ));

  if (conversations.isRefetchError) {
    return (
      <>
        <p className="morrow-chat-warning" role="status">Morrow could not refresh your chats. Showing the last saved list.</p>
        <ChatRows projectId={projectId} projectName={projectName} rows={rows} />
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="morrow-empty">
        <h2>{query.trim() ? "No matching history" : includeArchived ? "Nothing archived" : "No chats yet"}</h2>
        <p>{query.trim() ? "Try a different search." : includeArchived ? "Conversations you archive will show up here." : "Start a new chat and it will appear here."}</p>
      </div>
    );
  }

  return (
    <>
      <ChatRows projectId={projectId} projectName={projectName} rows={rows} />
      <aside className="morrow-principle">
        <b>History remembers the thread, not just the transcript.</b>
        <span>Return to past work by date and project while every conversation remains intact.</span>
      </aside>
    </>
  );
}

function ChatRows({ projectId, projectName, rows }: { projectId: string; projectName: string; rows: Conversation[] }) {
  const grouped = rows.reduce<Array<{ label: string; rows: Conversation[] }>>((groups, conversation) => {
    const label = dayLabel(conversation.updatedAt);
    const existing = groups.find((group) => group.label === label);
    if (existing) existing.rows.push(conversation);
    else groups.push({ label, rows: [conversation] });
    return groups;
  }, []);

  return (
    <div aria-label="Conversation history" className="morrow-chronicle">
      {grouped.map((group, groupIndex) => (
        <section className="morrow-chronicle__day" key={group.label}>
          <h2 className="morrow-chronicle__date">{group.label}</h2>
          <div className="morrow-chronicle__list">
            {group.rows.map((conversation, rowIndex) => (
              <Link
                className="morrow-chronicle__entry"
                data-featured={groupIndex === 0 && rowIndex === 0 && !conversation.archived}
                key={conversation.id}
                params={{ conversationId: conversation.id }}
                search={{ projectId }}
                to="/chats/$conversationId"
              >
                <div className="morrow-chronicle__top">
                  <span className="morrow-chronicle__kind">{conversation.archived ? "Archived" : "Conversation"}</span>
                  <span className="morrow-chronicle__project">{projectName}</span>
                  <time className="morrow-chronicle__time" dateTime={conversation.updatedAt}>{formatTime(conversation.updatedAt)}</time>
                </div>
                <h3>{conversation.title}</h3>
                <p>Open the conversation to review its messages, decisions, and visible work.</p>
                <div className="morrow-chronicle__result">
                  <span>{conversation.archived ? "Archived conversation" : "Continue where you left off"}</span>
                  <span className="morrow-chronicle__resume">Review →</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
