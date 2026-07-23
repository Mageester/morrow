import type { Conversation, WebMissionSummary } from "@morrow/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessageSquare, Workflow } from "lucide-react";
import { conversationQueries } from "../../api/conversations.js";
import { missionQueries } from "../../api/query-keys.js";
import { useActiveProject } from "../projects/use-active-project.js";
import { NewChatButton } from "../chat/new-chat-button.js";

const ACTIVE_MISSION_STATES = new Set([
  "draft",
  "working",
  "reviewing",
  "needs_input",
  "blocked",
]);

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

export function HomePage() {
  const projects = useActiveProject();
  const activeProject = projects.activeProject;
  const conversations = useQuery({
    ...conversationQueries.list(activeProject?.id ?? "", false),
    enabled: Boolean(activeProject),
  });
  const missions = useQuery({
    ...missionQueries.list(activeProject?.id ?? ""),
    enabled: Boolean(activeProject),
  });

  const recent = (conversations.data ?? [])
    .filter((conversation) => !conversation.archived)
    .slice(0, 6);
  const activeMissions = (missions.data ?? []).filter((mission) =>
    ACTIVE_MISSION_STATES.has(mission.state),
  );

  return (
    <section aria-labelledby="home-heading" className="morrow-page morrow-home">
      <div className="morrow-home__intro">
        <h1 id="home-heading">{greeting(new Date())}</h1>
        <p className="morrow-home__subtitle">What should we work on?</p>
        <div className="morrow-home__start">
          <NewChatButton className="morrow-new-chat__button--large" projectId={activeProject?.id} />
        </div>
      </div>

      {projects.isPending ? (
        <p aria-live="polite" role="status">
          Getting your workspace ready…
        </p>
      ) : projects.isError ? (
        <div className="morrow-inline-error">
          <p role="alert">Morrow could not reach your local workspace.</p>
          <button onClick={() => void projects.refetch()} type="button">
            Try again
          </button>
        </div>
      ) : !activeProject ? (
        <div className="morrow-empty">
          <h2>No local project yet</h2>
          <p>Create a local project and Morrow will keep your chats and work here.</p>
        </div>
      ) : (
        <>
          <ContinueSection projectId={activeProject.id} query={conversations} recent={recent} />
          {activeMissions.length > 0 ? (
            <ActiveWorkSection missions={activeMissions} />
          ) : null}
        </>
      )}
    </section>
  );
}

function ContinueSection({
  projectId,
  query,
  recent,
}: {
  projectId: string;
  query: UseQueryResult<Conversation[], Error>;
  recent: Conversation[];
}) {
  return (
    <section aria-labelledby="home-continue-heading" className="morrow-home__section">
      <div className="morrow-section-head">
        <h2 id="home-continue-heading">Continue where you left off</h2>
        <Link className="morrow-section-head__link" to="/chats">
          All chats
        </Link>
      </div>
      {query.isPending ? (
        <p aria-live="polite" role="status">
          Loading your recent chats…
        </p>
      ) : query.isError ? (
        <div className="morrow-inline-error">
          <p role="alert">Your recent chats could not be loaded.</p>
          <button onClick={() => void query.refetch()} type="button">
            Try again
          </button>
        </div>
      ) : recent.length === 0 ? (
        <div className="morrow-empty morrow-empty--soft">
          <p>No conversations yet. Start a new chat and it will appear here.</p>
        </div>
      ) : (
        <ul className="morrow-home__tiles">
          {recent.map((conversation) => (
            <li key={conversation.id}>
              <Link
                className="morrow-tile"
                params={{ conversationId: conversation.id }}
                search={{ projectId }}
                to="/chats/$conversationId"
              >
                <span className="morrow-tile__icon" aria-hidden="true">
                  <MessageSquare size={16} strokeWidth={1.8} />
                </span>
                <span className="morrow-tile__body">
                  <span className="morrow-tile__title">{conversation.title}</span>
                  <span className="morrow-tile__meta">Chat · {formatWhen(conversation.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActiveWorkSection({ missions }: { missions: WebMissionSummary[] }) {
  return (
    <section aria-labelledby="home-active-heading" className="morrow-home__section">
      <div className="morrow-section-head">
        <h2 id="home-active-heading">Active work</h2>
        <Link className="morrow-section-head__link" to="/missions">
          All missions
        </Link>
      </div>
      <ul className="morrow-home__missions">
        {missions.slice(0, 3).map((mission) => (
          <li key={mission.id}>
            <Link
              className="morrow-mission-row"
              params={{ missionId: mission.id }}
              to="/missions/$missionId"
            >
              <span className="morrow-mission-row__icon" aria-hidden="true">
                <Workflow size={16} strokeWidth={1.8} />
              </span>
              <span className="morrow-mission-row__body">
                <span className="morrow-mission-row__title">{mission.title}</span>
                <span className="morrow-mission-row__meta">
                  {mission.currentPhase}
                  {mission.totalMilestones > 0
                    ? ` · ${mission.completedMilestones}/${mission.totalMilestones} steps`
                    : ""}
                </span>
              </span>
              {mission.attentionCount > 0 ? (
                <span className="morrow-mission-row__attention">Needs you</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
