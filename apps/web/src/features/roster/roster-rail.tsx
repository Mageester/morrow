import type { RosterEntry, RosterStatus } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import { agentQueries } from "../../api/agents.js";
import { conversationQueries } from "../../api/conversations.js";
import { useActiveProject } from "../projects/use-active-project.js";
import { EditTeammatePanel, NewTeammatePanel } from "./new-teammate-panel.js";
import { TeamAutonomyToggle } from "./team-autonomy-toggle.js";
import { TeammateAvatar } from "./teammate-avatar.js";
import { useOpenTeammateThread } from "./use-open-teammate-thread.js";

/**
 * The rail is a list of teammates, not a list of conversations.
 *
 * A conversation list answers "what did I open recently?" — which is only
 * useful once you already know what you were doing. A roster answers "who is
 * doing what right now?", which is the question a person actually has when
 * more than one agent is working, and it is the only surface where an agent
 * running in a thread you are not looking at is visible at all.
 */

const STATUS_LABEL: Record<RosterStatus, string> = {
  working: "Working",
  waiting: "Waiting on you",
  idle: "Idle",
  disabled: "Off",
};

/** "3m", "2h", "4d" — enough to order the list without competing for width. */
function shortAge(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const at = Date.parse(isoDate);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/**
 * What to show on a teammate's second line when it has not said anything yet.
 * Naming the job is more use than an empty row or a repeated "No activity".
 */
function subtitleFor(entry: RosterEntry): string {
  if (entry.lastLine) return entry.lastLine;
  if (entry.status === "working") return "Starting work…";
  if (entry.instructions) return entry.instructions;
  return entry.agentId === null ? "Your general assistant" : "No work yet";
}

export function RosterRail({
  headingId = "roster-heading",
  onNavigate,
}: {
  headingId?: string;
  onNavigate: () => void;
}) {
  const { activeProject } = useActiveProject();
  // A conversation route names its own project, and that is authoritative
  // while you are reading it — otherwise arriving by link leaves the rail
  // blank, which is how most threads are opened.
  const routeProjectId = useRouterState({
    select: (state) => (state.location.search as { projectId?: string } | undefined)?.projectId,
  });
  // Read from the path rather than the route's params: this rail renders on
  // every route, and most of them have no conversationId to type against.
  const activeConversationId = useRouterState({
    select: (state) => /\/chats\/([^/?#]+)/.exec(state.location.pathname)?.[1],
  });
  const projectId = activeProject?.id ?? routeProjectId;

  const roster = useQuery({ ...agentQueries.roster(projectId ?? ""), enabled: Boolean(projectId) });
  // Which teammate owns the thread on screen, so the right row reads as
  // current even when it is not the teammate's most recent conversation.
  const openConversation = useQuery({
    ...conversationQueries.detail(projectId ?? "", activeConversationId ?? ""),
    enabled: Boolean(projectId) && Boolean(activeConversationId),
  });
  const { open, openingAgentId, error } = useOpenTeammateThread(projectId);
  const [creating, setCreating] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);

  if (!projectId) return null;

  const entries = roster.data?.entries ?? [];
  const currentAgentId = openConversation.data?.agentId ?? null;
  const hasOpenThread = Boolean(activeConversationId) && openConversation.isSuccess;

  return (
    <div className="morrow-roster">
      <div className="morrow-roster__head">
        <p className="morrow-roster__title" id={headingId}>Teammates</p>
        <button
          aria-label="New teammate"
          className="morrow-roster__add"
          onClick={() => setCreating(true)}
          type="button"
        >
          <Plus aria-hidden="true" size={14} strokeWidth={2.2} />
        </button>
      </div>

      {/* The one decision that makes a team of workers usable, above the
          per-teammate detail rather than buried inside one teammate's editor. */}
      <TeamAutonomyToggle projectId={projectId} />

      {roster.isPending ? (
        <p aria-live="polite" className="morrow-roster__note" role="status">Reading the roster…</p>
      ) : roster.isError ? (
        <div className="morrow-roster__note">
          <p role="alert">The roster could not be loaded.</p>
          <button onClick={() => void roster.refetch()} type="button">Try again</button>
        </div>
      ) : (
        <ul aria-labelledby={headingId} className="morrow-roster__list">
          {entries.map((entry) => (
            <RosterRow
              current={hasOpenThread && currentAgentId === entry.agentId}
              entry={entry}
              key={entry.agentId ?? "default"}
              onOpen={() => {
                open(entry);
                onNavigate();
              }}
              onEdit={() => {
                setCreating(false);
                setEditingAgentId(entry.agentId);
              }}
              opening={openingAgentId === entry.agentId}
            />
          ))}
        </ul>
      )}

      {error ? <p className="morrow-roster__note" role="alert">{error}</p> : null}

      {creating ? (
        <NewTeammatePanel
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            // Straight into a thread with them: a teammate you cannot talk to
            // yet is an entry in a settings list, not a colleague.
            open({ agentId: agent.id, conversationId: null });
            onNavigate();
          }}
          projectId={projectId}
        />
      ) : null}

      {editingAgentId ? (
        <EditTeammatePanel
          agentId={editingAgentId}
          onClose={() => setEditingAgentId(null)}
          onUpdated={() => setEditingAgentId(null)}
          projectId={projectId}
        />
      ) : null}
    </div>
  );
}

function RosterRow({
  entry,
  current,
  opening,
  onOpen,
  onEdit,
}: {
  entry: RosterEntry;
  current: boolean;
  opening: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const age = shortAge(entry.lastActivityAt);
  const isDefault = entry.agentId === null;

  return (
    <li>
      <button
        aria-current={current ? "page" : undefined}
        aria-label={`${entry.name} — ${STATUS_LABEL[entry.status]}`}
        className="morrow-roster__row"
        data-status={entry.status}
        data-testid="roster-row"
        disabled={opening}
        onClick={onOpen}
        type="button"
      >
        <TeammateAvatar isDefault={isDefault} name={entry.name} status={entry.status} />
        <span className="morrow-roster__body">
          <span className="morrow-roster__line">
            <span className="morrow-roster__name">{entry.name}</span>
            {age ? <span className="morrow-roster__age">{age}</span> : null}
          </span>
          <span className="morrow-roster__subtitle">{subtitleFor(entry)}</span>
        </span>
        <span
          className="morrow-roster__status"
          data-status={entry.status}
          title={STATUS_LABEL[entry.status]}
        >
          <span aria-hidden="true" className="morrow-roster__dot" />
          <span className="morrow-visually-hidden">{STATUS_LABEL[entry.status]}</span>
        </span>
      </button>
      {entry.agentId ? (
        <button
          aria-label={`Configure ${entry.name}`}
          className="morrow-roster__configure"
          onClick={onEdit}
          type="button"
        >
          <Settings2 aria-hidden="true" size={13} strokeWidth={1.8} />
          <span className="morrow-visually-hidden">Configure</span>
        </button>
      ) : null}
    </li>
  );
}
