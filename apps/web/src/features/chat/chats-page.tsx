import type { Conversation } from "@morrow/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { conversationQueries } from "../../api/conversations.js";
import { projectQueries } from "../../api/projects.js";
import { NewChatButton } from "./new-chat-button.js";

type ChatsTab = "active" | "archived";

function formatUpdated(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

export function ChatsPage() {
  const projects = useQuery(projectQueries.list());
  const activeProject = projects.data?.[0];
  const [tab, setTab] = useState<ChatsTab>("active");
  const includeArchived = tab === "archived";
  const conversations = useQuery({
    ...conversationQueries.list(activeProject?.id ?? "", includeArchived),
    enabled: Boolean(activeProject),
  });

  return (
    <section aria-labelledby="chats-heading" className="morrow-page morrow-chats">
      <div className="morrow-chats__head">
        <div className="morrow-page__heading">
          <h1 id="chats-heading">Chats</h1>
          <p>Every conversation you’ve had with Morrow, kept with its project.</p>
        </div>
        {activeProject ? <NewChatButton projectId={activeProject.id} /> : null}
      </div>

      {projects.isPending ? (
        <p aria-live="polite" role="status">
          Loading your projects…
        </p>
      ) : projects.isError ? (
        <div className="morrow-inline-error">
          <p role="alert">Your projects could not be loaded.</p>
          <button onClick={() => void projects.refetch()} type="button">
            Try again
          </button>
        </div>
      ) : !activeProject ? (
        <div className="morrow-empty">
          <h2>No local project yet</h2>
          <p>Create a local project and your conversations will collect here.</p>
        </div>
      ) : (
        <>
          <div aria-label="Filter chats" className="morrow-chats__tabs" role="group">
            <button
              aria-pressed={tab === "active"}
              className="morrow-chats__tab"
              onClick={() => setTab("active")}
              type="button"
            >
              Active
            </button>
            <button
              aria-pressed={tab === "archived"}
              className="morrow-chats__tab"
              onClick={() => setTab("archived")}
              type="button"
            >
              Archived
            </button>
          </div>
          <ChatList
            conversations={conversations}
            includeArchived={includeArchived}
            projectId={activeProject.id}
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
}: {
  conversations: UseQueryResult<Conversation[], Error>;
  includeArchived: boolean;
  projectId: string;
}) {
  if (conversations.isPending) {
    return (
      <p aria-live="polite" role="status">
        Loading your chats…
      </p>
    );
  }
  if (conversations.isError) {
    return (
      <div className="morrow-inline-error">
        <p role="alert">Your chats could not be loaded.</p>
        <button onClick={() => void conversations.refetch()} type="button">
          Try again
        </button>
      </div>
    );
  }

  const all = conversations.data ?? [];
  // The archived view asks the API for everything and keeps only archived rows;
  // the active view keeps only live ones. Filtering both ways stays correct even
  // if an endpoint returns more than requested.
  const rows = includeArchived
    ? all.filter((conversation) => conversation.archived)
    : all.filter((conversation) => !conversation.archived);

  if (conversations.isRefetchError) {
    // Kept, useful data with a non-blocking warning instead of an empty screen.
    return (
      <>
        <p className="morrow-chat-warning" role="status">
          Morrow could not refresh your chats. Showing the last saved list.
        </p>
        <ChatRows projectId={projectId} rows={rows} />
      </>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="morrow-empty">
        <h2>{includeArchived ? "Nothing archived" : "No chats yet"}</h2>
        <p>
          {includeArchived
            ? "Conversations you archive will show up here."
            : "Start a new chat and it will appear here."}
        </p>
      </div>
    );
  }

  return <ChatRows projectId={projectId} rows={rows} />;
}

function ChatRows({ projectId, rows }: { projectId: string; rows: Conversation[] }) {
  return (
    <ul className="morrow-chats__list">
      {rows.map((conversation) => (
        <li className="morrow-chats__row" key={conversation.id}>
          <Link
            className="morrow-chats__link"
            params={{ conversationId: conversation.id }}
            search={{ projectId }}
            to="/chats/$conversationId"
          >
            {conversation.title}
          </Link>
          <span className="morrow-chats__meta">{formatUpdated(conversation.updatedAt)}</span>
        </li>
      ))}
    </ul>
  );
}
