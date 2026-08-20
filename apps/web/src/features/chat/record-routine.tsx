import type { RoutineProposal, RoutineStep } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Circle, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiClientError } from "../../api/client.js";
import { routineApi, routineKeys, routineQueries } from "../../api/routines.js";
import { useThreadTeammate } from "../roster/use-thread-teammate.js";

/**
 * "Watch me do this once, then do it yourself."
 *
 * Recording is explicit and opt-in, and it changes nothing about how the
 * teammate works while it is on — it only marks a span of this thread. When
 * it stops, Morrow reads back what actually happened in that span and offers
 * a routine. Saving it is a separate act: a proposal is a draft, never
 * something created behind the user's back.
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

function formatElapsed(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "00:00";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

function cloneSteps(steps: RoutineStep[]): RoutineStep[] {
  return steps.map((step) => ({ ...step }));
}

export function RecordRoutine({ projectId, conversationId, agentId }: RecordRoutineProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RoutineProposal | null>(null);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [steps, setSteps] = useState<RoutineStep[]>([]);
  const [hideProposal, setHideProposal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const state = useQuery(routineQueries.recording(projectId, conversationId));
  const recording = state.data?.recording ?? null;
  const serverProposal = state.data?.proposal ?? null;
  const isRecording = Boolean(recording && recording.stoppedAt === null);
  const proposal = hideProposal ? null : draft ?? serverProposal;
  const teammate = useThreadTeammate(projectId, proposal?.agentId ?? agentId);
  const teammateLabel = teammate?.name ?? ((proposal?.agentId ?? agentId) ? "your teammate" : "Morrow");

  const hydrateProposal = (next: RoutineProposal) => {
    setDraft(next);
    setName(next.suggestedName);
    setObjective(next.objective);
    setSteps(cloneSteps(next.steps));
    setHideProposal(false);
  };

  // A closed proposal is durable state. Rehydrate it after a reload, while
  // leaving an explicitly discarded/saved draft dismissed in this session.
  useEffect(() => {
    if (!state.data) return;
    if (!state.data.proposal) {
      setHideProposal(false);
      return;
    }
    if (!draft && !hideProposal && state.data.recording?.routineId === null) {
      hydrateProposal(state.data.proposal);
    }
  }, [draft, hideProposal, state.data]);

  // The timer is derived from the server's startedAt, so a refresh never
  // resets it to zero or fabricates a local start time.
  useEffect(() => {
    if (!isRecording || !recording) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRecording, recording?.id, recording?.startedAt]);

  const invalidateRecording = () => queryClient.invalidateQueries({ queryKey: routineKeys.recording(projectId, conversationId) });

  const start = useMutation({
    mutationFn: () => routineApi.startRecording(projectId, conversationId),
    onSuccess: () => {
      setActionError(null);
      setDraft(null);
      setHideProposal(true);
      void invalidateRecording();
    },
    onError: (cause) => setActionError(errorMessage(cause, "That recording could not be started.")),
  });

  const stop = useMutation({
    mutationFn: () => routineApi.stopRecording(projectId, conversationId),
    onSuccess: (result) => {
      setActionError(null);
      void invalidateRecording();
      if (result.proposal && result.proposal.taskCount > 0) hydrateProposal(result.proposal);
      else {
        setDraft(null);
        setHideProposal(false);
      }
    },
    onError: (cause) => setActionError(errorMessage(cause, "That recording could not be stopped.")),
  });

  const save = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error("There is no routine proposal to save.");
      return routineApi.save(projectId, {
        name: name.trim(),
        objective: objective.trim(),
        steps: cloneSteps(steps),
        agentId: draft.agentId ?? agentId,
        sourceConversationId: conversationId,
      });
    },
    onSuccess: () => {
      setDraft(null);
      setHideProposal(true);
      void queryClient.invalidateQueries({ queryKey: routineKeys.list(projectId) });
      void invalidateRecording();
    },
  });

  const updateStep = (index: number, patch: Partial<RoutineStep>) => {
    setSteps((current) => current.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step));
  };

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

      {actionError ? <p className="morrow-record__error" role="alert">{actionError}</p> : null}

      {isRecording && recording ? (
        <div className="morrow-record__active" role="status">
          <div className="morrow-record__active-line">
            <span className="morrow-record__live-dot" aria-hidden="true" />
            <strong>Watching and learning</strong>
            <time dateTime={recording.startedAt}>{formatElapsed(recording.startedAt, now)}</time>
          </div>
          <p className="morrow-record__hint">Work with your teammate as usual. Morrow is learning the shape of this task from what actually happens.</p>
        </div>
      ) : null}

      {stop.isSuccess && (!stop.data?.proposal || stop.data.proposal.taskCount === 0) && !isRecording && !draft ? (
        <p className="morrow-record__hint">
          Nothing was recorded in that span, so there is no routine to propose.
        </p>
      ) : null}

      {proposal ? (
        <form
          className="morrow-record__proposal"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && objective.trim() && !save.isPending) save.mutate();
          }}
        >
          <div className="morrow-record__proposal-heading">
            <div>
              <span className="morrow-record__eyebrow">Draft from demonstration</span>
              <h3>Keep this as a routine?</h3>
            </div>
            <span className="morrow-record__teammate">Runs as {teammateLabel}</span>
          </div>

          <div className="morrow-record__facts" aria-label="Observed facts">
            <span>Observed {proposal.taskCount} {proposal.taskCount === 1 ? "task" : "tasks"}</span>
            <span>{steps.length} {steps.length === 1 ? "successful step" : "successful steps"}</span>
          </div>

          <fieldset className="morrow-record__fieldset">
            <legend>Routine details</legend>
            <label className="morrow-field">
              <span className="morrow-field__label">Name</span>
              <input
                aria-label="Routine name"
                className="morrow-field__input"
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </label>
            <label className="morrow-field">
              <span className="morrow-field__label">Purpose</span>
              <textarea
                aria-label="Purpose"
                className="morrow-field__input morrow-field__textarea"
                maxLength={4000}
                onChange={(event) => setObjective(event.target.value)}
                rows={3}
                value={objective}
              />
            </label>
          </fieldset>

          <fieldset className="morrow-record__fieldset">
            <legend>Observed steps</legend>
            <p className="morrow-record__subcopy">Edit the facts Morrow saw. Targets are context for the next request, not commands to replay.</p>
            {steps.length > 0 ? (
              <ol className="morrow-record__steps">
                {steps.map((step, index) => (
                  <li key={`observed-step-${index}`}>
                    <label className="morrow-field">
                      <span className="morrow-field__label">Step {index + 1}</span>
                      <input
                        aria-label={`Observed step ${index + 1}`}
                        className="morrow-field__input"
                        maxLength={240}
                        onChange={(event) => updateStep(index, { summary: event.target.value })}
                        value={step.summary}
                      />
                    </label>
                    <label className="morrow-field">
                      <span className="morrow-field__label">Target</span>
                      <input
                        aria-label={`Observed target ${index + 1}`}
                        className="morrow-field__input"
                        maxLength={500}
                        onChange={(event) => updateStep(index, { target: event.target.value || null })}
                        value={step.target ?? ""}
                      />
                    </label>
                    <button
                      aria-label={`Remove observed step ${index + 1}`}
                      className="morrow-record__remove-step"
                      onClick={() => setSteps((current) => current.filter((_, stepIndex) => stepIndex !== index))}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="morrow-record__hint">No successful tool steps were observed. The purpose is the routine.</p>
            )}
            <button
              className="morrow-record__add-step"
              disabled={steps.length >= 200}
              onClick={() => setSteps((current) => [...current, { summary: "Describe the next step", target: null, toolName: null }])}
              type="button"
            >
              <Plus aria-hidden="true" size={13} />
              Add observed step
            </button>
          </fieldset>

          <aside className="morrow-record__boundary" aria-label="Permission boundary">
            <strong>Permission boundary</strong>
            <p>Running this starts a fresh request for {teammateLabel}. It re-checks every step under the current tools, approvals, memory scopes, and workspace state; it never replays captured commands or writes.</p>
          </aside>

          {save.isError ? (
            <p className="morrow-record__error" role="alert">
              {errorMessage(save.error, "That routine could not be saved.")}
            </p>
          ) : null}

          <div className="morrow-record__actions">
            <button onClick={() => { setDraft(null); setHideProposal(true); }} type="button">Discard</button>
            <button className="morrow-record__save" disabled={!name.trim() || !objective.trim() || save.isPending} type="submit">
              {save.isPending ? "Saving…" : "Save routine"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
