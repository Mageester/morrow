import type { ConversationParticipant } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Plus, UserMinus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { agentQueries } from "../../api/agents.js";
import {
  conversationParticipantApi,
  conversationParticipantKeys,
  conversationParticipantQueries,
} from "../../api/conversation-participants.js";
import { TeammateAvatar } from "../roster/teammate-avatar.js";

function orderedParticipants(participants: ConversationParticipant[]): ConversationParticipant[] {
  return [...participants]
    .filter((participant) => participant.status === "active")
    .sort((left, right) => left.position - right.position || left.joinedAt.localeCompare(right.joinedAt) || left.id.localeCompare(right.id));
}

export interface GroupParticipantStripProps {
  projectId: string;
  conversationId: string;
  /** Read-only mode is useful for shared links and narrow mobile previews. */
  editable?: boolean;
}

export function GroupParticipantStrip({ projectId, conversationId, editable = true }: GroupParticipantStripProps) {
  const queryClient = useQueryClient();
  const participants = useQuery(conversationParticipantQueries.detail(projectId, conversationId));
  const agents = useQuery(agentQueries.list(projectId));
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteAgentId, setInviteAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const activeParticipants = useMemo(() => orderedParticipants(participants.data?.participants ?? []), [participants.data?.participants]);
  const activeIds = useMemo(() => new Set(activeParticipants.map((participant) => participant.agentId).filter(Boolean)), [activeParticipants]);
  const candidates = (agents.data ?? []).filter((agent) => agent.enabled && !agent.teamId && !activeIds.has(agent.id) && agent.id !== participants.data?.conductorAgentId);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: conversationParticipantKeys.detail(projectId, conversationId, false) });
  };

  const invite = useMutation({
    mutationFn: () => conversationParticipantApi.invite(projectId, conversationId, inviteAgentId),
    onSuccess: () => {
      setInviteAgentId("");
      setInviteOpen(false);
      setError(null);
      invalidate();
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "The teammate could not be invited."),
  });

  const remove = useMutation({
    mutationFn: (agentId: string) => conversationParticipantApi.remove(projectId, conversationId, agentId),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "The teammate could not be removed."),
  });

  const reorder = useMutation({
    mutationFn: ({ agentId, position }: { agentId: string; position: number }) => conversationParticipantApi.reorder(projectId, conversationId, agentId, position),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "The teammate order could not be changed."),
  });

  if (participants.isPending) {
    return <section aria-label="Conversation participants" className="morrow-group-participants" data-testid="group-participant-strip"><p className="morrow-group-participants__note" role="status">Loading participants…</p></section>;
  }
  if (participants.isError || !participants.data) {
    return <section aria-label="Conversation participants" className="morrow-group-participants" data-testid="group-participant-strip"><p className="morrow-group-participants__note" role="alert">Participants could not be loaded.</p></section>;
  }

  return (
    <section aria-label="Conversation participants" className="morrow-group-participants" data-testid="group-participant-strip">
      <header className="morrow-group-participants__head">
        <div>
          <p className="morrow-group-participants__eyebrow">Shared thread</p>
          <h2 className="morrow-group-participants__title">Participants</h2>
        </div>
        {editable ? (
          <button
            aria-expanded={inviteOpen}
            aria-label="Invite teammate"
            className="morrow-group-participants__invite-trigger"
            onClick={() => { setInviteOpen((open) => !open); setError(null); }}
            type="button"
          >
            {inviteOpen ? <X aria-hidden="true" size={15} /> : <Plus aria-hidden="true" size={15} />}
            <span>{inviteOpen ? "Close" : "Invite"}</span>
          </button>
        ) : null}
      </header>

      <div aria-label="Active participants" className="morrow-group-participants__list" role="list">
        {activeParticipants.map((participant, index) => {
          const conductor = participant.role === "conductor" || participant.isConductor;
          const agentId = participant.agentId;
          const canMoveUp = !conductor && index > 1;
          const canMoveDown = !conductor && index >= 1 && index < activeParticipants.length - 1;
          return (
            <div className="morrow-group-participants__item" data-testid="group-participant" data-role={conductor ? "conductor" : "participant"} key={participant.id} role="listitem">
              <TeammateAvatar isDefault={!agentId} name={participant.nameSnapshot} size="sm" />
              <span className="morrow-group-participants__identity">
                <span className="morrow-group-participants__name">{participant.nameSnapshot}</span>
                <span className="morrow-group-participants__role">{conductor ? "Conductor" : participant.roleSnapshot}</span>
              </span>
              {editable && !conductor && agentId ? (
                <span className="morrow-group-participants__actions">
                  <button aria-label={`Move ${participant.nameSnapshot} up`} disabled={!canMoveUp || reorder.isPending} onClick={() => reorder.mutate({ agentId, position: Math.max(1, participant.position - 1) })} title="Move up" type="button"><ChevronUp aria-hidden="true" size={14} /></button>
                  <button aria-label={`Move ${participant.nameSnapshot} down`} disabled={!canMoveDown || reorder.isPending} onClick={() => reorder.mutate({ agentId, position: participant.position + 1 })} title="Move down" type="button"><ChevronDown aria-hidden="true" size={14} /></button>
                  <button aria-label={`Remove ${participant.nameSnapshot}`} disabled={remove.isPending} onClick={() => remove.mutate(agentId)} title="Remove participant" type="button"><UserMinus aria-hidden="true" size={14} /></button>
                </span>
              ) : <span aria-label="Conductor cannot be removed" className="morrow-group-participants__conductor-mark">Lead</span>}
            </div>
          );
        })}
      </div>

      {inviteOpen ? (
        <div aria-label="Invite teammate" className="morrow-group-participants__invite" role="dialog">
          <label htmlFor={`${conversationId}-participant-invite`}>Teammate to invite</label>
          <select id={`${conversationId}-participant-invite`} onChange={(event) => setInviteAgentId(event.target.value)} value={inviteAgentId}>
            <option value="">Choose a teammate…</option>
            {candidates.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          <button disabled={!inviteAgentId || invite.isPending} onClick={() => invite.mutate()} type="button">{invite.isPending ? "Inviting…" : "Invite"}</button>
        </div>
      ) : null}
      {error ? <p className="morrow-group-participants__error" role="alert">{error}</p> : null}
    </section>
  );
}
