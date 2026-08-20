import type { RoutineProposal } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Circle, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiClientError } from "../../api/client.js";
import { routineApi, routineKeys, routineQueries } from "../../api/routines.js";

/**
 * "Watch me do this once, then do it yourself."
 *
 * Recording is explicit and opt-in, and it changes nothing about how the
 * teammate works while it is on — it only marks a span of this thread. When it
 * stops, Morrow reads back what actually happened in that span and offers a
 * routine. Saving it is a separate act: a proposal is a draft, never something
 * created behind the user's back.
 *
 * The honest limit is stated in the panel itself, because it is the thing a
 * user would otherwise assume wrongly: a saved routine re-asks the teammate,
 * with the observed steps as context. It does not replay the recorded tool
 * calls against a workspace that has since moved on.
 */

export interface RecordRoutineProps {
  projectId: string;
  conversationId: string;
  agentId: string | null;
}

export function RecordRoutine({ projectId, conversationId, agentId }: RecordRoutineProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RoutineProposal | null>(null);
  const [name, setName] = useState("");

  const state = useQuery(routineQueries.recording(projectId, conversationId));
  const recording = state.data?.recording ?? null;
  const isRecording = Boolean(recording && recording.stoppedAt === null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: routineKeys.recording(projectId, conversationId) });

  const start = useMutation({
    mutationFn: () => routineApi.startRecording(projectId, conversationId),
    onSuccess: () => {
      setDraft(null);
      void invalidate();
    },
  });

  const stop = useMutation({
    mutationFn: () => routineApi.stopRecording(projectId, conversationId),
    onSuccess: (result) => {
      void invalidate();
      // Nothing was observed: there is no routine to propose, and offering an
      // empty one would be a worse answer than saying so.
      if (result.proposal && result.proposal.taskCount > 0) {
        setDraft(result.proposal);
        setName(result.proposal.suggestedName);
      }
    },
  });

  const save = useMutation({
    mutationFn: () =>
      routineApi.save(projectId, {
        name: name.trim(),
        objective: draft!.objective,
        steps: draft!.steps,
        agentId,
        sourceConversationId: conversationId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: routineKeys.list(projectId) });
      setDraft(null);
    },
  });

  useEffect(() => {
    if (!draft) setName("");
  }, [draft]);

  return (
    <div className="morrow-record">
      <button
        aria-pressed={isRecording}
        className="morrow-record__toggle"
        data-recording={isRecording ? "true" : undefined}
        disabled={start.isPending || stop.isPending}
        onClick={() => (isRecording ? stop.mutate() : start.mutate())}
        type="button"
      >
        {isRecording
          ? <Square aria-hidden="true" fill="currentColor" size={9} />
          : <Circle aria-hidden="true" fill="currentColor" size={9} />}
        <span>{isRecording ? "Stop recording" : "Record a routine"}</span>
      </button>

      {isRecording ? (
        <p className="morrow-record__hint" role="status">
          Watching. Work with your teammate as usual — Morrow will offer a routine when you stop.
        </p>
      ) : null}

      {stop.isSuccess && !draft ? (
        <p className="morrow-record__hint">
          Nothing was recorded in that span, so there is no routine to propose.
        </p>
      ) : null}

      {draft ? (
        <form
          className="morrow-record__proposal"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !save.isPending) save.mutate();
          }}
        >
          <h3>Keep this as a routine?</h3>
          <label className="morrow-field">
            <span className="morrow-field__label">Name</span>
            <input
              className="morrow-field__input"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>

          <p className="morrow-record__objective">{draft.objective}</p>

          {draft.steps.length > 0 ? (
            <ol className="morrow-record__steps">
              {draft.steps.slice(0, 8).map((step, index) => (
                <li key={`${step.summary}-${index}`}>
                  <span>{step.summary}</span>
                  {step.target ? <code>{step.target}</code> : null}
                </li>
              ))}
              {draft.steps.length > 8 ? (
                <li className="morrow-record__steps-more">and {draft.steps.length - 8} more</li>
              ) : null}
            </ol>
          ) : (
            <p className="morrow-record__hint">No tool steps were recorded — this routine is the request alone.</p>
          )}

          <p className="morrow-record__hint">
            Running this re-asks your teammate, with these steps as context. It does not replay them — the workspace
            will have moved on, and each step gets decided again against how things actually are.
          </p>

          {save.isError ? (
            <p className="morrow-record__hint" role="alert">
              {save.error instanceof ApiClientError ? save.error.message : "That routine could not be saved."}
            </p>
          ) : null}

          <div className="morrow-record__actions">
            <button onClick={() => setDraft(null)} type="button">Discard</button>
            <button className="morrow-record__save" disabled={!name.trim() || save.isPending} type="submit">
              {save.isPending ? "Saving…" : "Save routine"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
