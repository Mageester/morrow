import type { RosterEntry } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { agentQueries } from "../../api/agents.js";
import { ApiClientError } from "../../api/client.js";
import { handoffApi, handoffKeys } from "../../api/handoffs.js";
import { TeammateAvatar } from "../roster/teammate-avatar.js";

/**
 * Hand a piece of this thread's work to another teammate.
 *
 * The thread you are in belongs to one teammate; this is how a second one
 * joins it. What they get is the objective typed here and nothing else — no
 * copy of this conversation — and they run under their own policy, so a
 * teammate you would not trust with the workspace does not acquire that trust
 * by being asked from a thread that has it.
 */

export interface AskTeammateProps {
  projectId: string;
  conversationId: string;
  /** The turn the handoff hangs off. Null before this thread has any. */
  parentTaskId: string | null;
  /** The teammate whose thread this is; they cannot be handed their own work. */
  currentAgentId: string | null;
}

export function AskTeammate({ projectId, conversationId, parentTaskId, currentAgentId }: AskTeammateProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<RosterEntry | null>(null);
  const [objective, setObjective] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);

  const roster = useQuery({ ...agentQueries.roster(projectId), enabled: open });

  useEffect(() => {
    if (chosen) objectiveRef.current?.focus();
  }, [chosen]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onPointerDown(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const ask = useMutation({
    mutationFn: () =>
      handoffApi.start(projectId, conversationId, {
        parentTaskId: parentTaskId!,
        agentId: chosen!.agentId!,
        objective: objective.trim(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: handoffKeys.thread(projectId, conversationId) });
      void queryClient.invalidateQueries({ queryKey: agentQueries.roster(projectId).queryKey });
      setOpen(false);
      setChosen(null);
      setObjective("");
    },
  });

  // Only named teammates can be handed work: the default teammate is this
  // thread's own voice, not somebody else to ask.
  const candidates = (roster.data?.entries ?? []).filter(
    (entry) => entry.agentId !== null && entry.agentId !== currentAgentId && entry.enabled,
  );

  if (!parentTaskId) return null;

  return (
    <div className="morrow-ask-teammate" ref={panelRef}>
      <button
        aria-expanded={open}
        className="morrow-ask-teammate__trigger"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <UserPlus aria-hidden="true" size={13} strokeWidth={1.9} />
        <span>Ask a teammate</span>
      </button>

      {open ? (
        <div className="morrow-ask-teammate__panel" role="dialog" aria-label="Ask a teammate">
          {roster.isPending ? (
            <p className="morrow-ask-teammate__note" role="status">Reading the roster…</p>
          ) : candidates.length === 0 ? (
            <p className="morrow-ask-teammate__note">
              There is no one else to ask yet. Create a teammate in the rail and they can join this thread.
            </p>
          ) : !chosen ? (
            <ul className="morrow-ask-teammate__list">
              {candidates.map((entry) => (
                <li key={entry.agentId}>
                  <button className="morrow-ask-teammate__option" onClick={() => setChosen(entry)} type="button">
                    <TeammateAvatar name={entry.name} size="sm" />
                    <span className="morrow-ask-teammate__option-name">{entry.name}</span>
                    <span className="morrow-ask-teammate__option-role">{entry.role.replace(/-/g, " ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <form
              className="morrow-ask-teammate__form"
              onSubmit={(event) => {
                event.preventDefault();
                if (objective.trim() && !ask.isPending) ask.mutate();
              }}
            >
              <p className="morrow-ask-teammate__chosen">
                <TeammateAvatar name={chosen.name} size="sm" />
                <span>Ask {chosen.name} to…</span>
                <button onClick={() => setChosen(null)} type="button">Change</button>
              </p>
              <textarea
                className="morrow-ask-teammate__objective"
                maxLength={2000}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Check whether the release notes mention the new export format."
                ref={objectiveRef}
                rows={3}
                value={objective}
              />
              <p className="morrow-ask-teammate__hint">
                {chosen.name} gets this objective and nothing else — not a copy of this thread — and runs under their
                own tools, memory and budget.
              </p>
              {ask.isError ? (
                <p className="morrow-ask-teammate__note" role="alert">
                  {ask.error instanceof ApiClientError ? ask.error.message : "That handoff could not be started."}
                </p>
              ) : null}
              <div className="morrow-ask-teammate__actions">
                <button onClick={() => setOpen(false)} type="button">Cancel</button>
                <button
                  className="morrow-ask-teammate__submit"
                  disabled={!objective.trim() || ask.isPending}
                  type="submit"
                >
                  {ask.isPending ? "Asking…" : `Ask ${chosen.name}`}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
