import type { Routine, RoutineStep } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Play, Plus, Save, Trash2, X } from "lucide-react";
import { useState } from "react";
import { ApiClientError } from "../../api/client.js";
import { routineApi, routineKeys, routineQueries } from "../../api/routines.js";
import { TeammateAvatar } from "../roster/teammate-avatar.js";
import { useThreadTeammate } from "../roster/use-thread-teammate.js";

/**
 * Routines a teammate was taught by demonstration.
 *
 * Kept beside Skills because they answer the same question — "what can be
 * repeated?" — but they are a different kind of thing and say so: a skill is
 * a method Morrow ships or proves out, a routine is a job one of your
 * teammates was shown once and can be asked to do again.
 */

function formatWhen(iso: string | null): string {
  if (!iso) return "never run";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "never run";
  return `last run ${new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

function cloneSteps(steps: RoutineStep[]): RoutineStep[] {
  return steps.map((step) => ({ ...step }));
}

interface RoutineDraft {
  name: string;
  objective: string;
  steps: RoutineStep[];
}

function draftFor(routine: Routine): RoutineDraft {
  return { name: routine.name, objective: routine.objective, steps: cloneSteps(routine.steps) };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

export function RoutinesPanel({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoutineDraft | null>(null);
  const routines = useQuery(routineQueries.list(projectId));

  const run = useMutation({
    mutationFn: (routineId: string) => routineApi.run(routineId),
    onSuccess: (result) => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: routineKeys.list(projectId) });
      void navigate({
        params: { conversationId: result.conversationId },
        search: { projectId },
        to: "/chats/$conversationId",
      });
    },
    onError: (cause) => {
      setError(errorMessage(cause, "That routine could not be started."));
    },
  });

  const update = useMutation({
    mutationFn: ({ routineId, input }: { routineId: string; input: RoutineDraft }) => routineApi.update(projectId, routineId, input),
    onSuccess: () => {
      setError(null);
      setEditingId(null);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: routineKeys.list(projectId) });
    },
    onError: (cause) => {
      setError(errorMessage(cause, "That routine could not be updated."));
    },
  });

  const remove = useMutation({
    mutationFn: (routineId: string) => routineApi.remove(routineId, projectId),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: routineKeys.list(projectId) });
    },
    onError: (cause) => {
      setError(errorMessage(cause, "That routine could not be deleted."));
    },
  });

  const rows = routines.data ?? [];
  if (rows.length === 0) return null;

  const beginEdit = (routine: Routine) => {
    setError(null);
    setEditingId(routine.id);
    setDraft(draftFor(routine));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  return (
    <section aria-labelledby="routines-heading" className="morrow-routines">
      <div className="morrow-section-head">
        <h2 id="routines-heading">Routines</h2>
        <span>Taught by demonstration</span>
      </div>
      {error ? <p className="morrow-routines__error" role="alert">{error}</p> : null}
      <ul className="morrow-routines__list">
        {rows.map((routine) => (
          editingId === routine.id && draft ? (
            <RoutineEditor
              draft={draft}
              key={routine.id}
              routine={routine}
              saving={update.isPending}
              onCancel={cancelEdit}
              onChange={setDraft}
              onSave={() => update.mutate({ routineId: routine.id, input: draft })}
            />
          ) : (
            <li className="morrow-routines__row" key={routine.id}>
              <RoutineOwner agentId={routine.agentId} projectId={projectId} />
              <span className="morrow-routines__body">
                <span className="morrow-routines__name">{routine.name}</span>
                <span className="morrow-routines__meta">
                  {routine.steps.length} {routine.steps.length === 1 ? "step" : "steps"}
                  {" · "}
                  {routine.runCount} {routine.runCount === 1 ? "run" : "runs"}
                  {" · "}
                  {formatWhen(routine.lastRunAt)}
                </span>
              </span>
              <button
                aria-label={`Edit ${routine.name}`}
                className="morrow-routines__edit"
                onClick={() => beginEdit(routine)}
                type="button"
              >
                Edit
              </button>
              <button
                className="morrow-routines__run"
                disabled={run.isPending}
                onClick={() => run.mutate(routine.id)}
                type="button"
              >
                <Play aria-hidden="true" size={12} />
                <span>Run</span>
              </button>
              <button
                aria-label={`Delete ${routine.name}`}
                className="morrow-routines__delete"
                disabled={remove.isPending}
                onClick={() => remove.mutate(routine.id)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={13} />
              </button>
            </li>
          )
        ))}
      </ul>
    </section>
  );
}

function RoutineEditor({
  draft,
  routine,
  saving,
  onCancel,
  onChange,
  onSave,
}: {
  draft: RoutineDraft;
  routine: Routine;
  saving: boolean;
  onCancel: () => void;
  onChange: (draft: RoutineDraft) => void;
  onSave: () => void;
}) {
  const updateStep = (index: number, patch: Partial<RoutineStep>) => {
    onChange({ ...draft, steps: draft.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step) });
  };

  return (
    <li className="morrow-routines__editor" key={routine.id}>
      <div className="morrow-routines__editor-head">
        <RoutineOwner agentId={routine.agentId} projectId={routine.projectId} />
        <div>
          <strong>Edit routine</strong>
          <span>{routine.runCount} {routine.runCount === 1 ? "run" : "runs"} · {formatWhen(routine.lastRunAt)}</span>
        </div>
        <span className="morrow-routines__provenance">History and original demonstration stay intact</span>
      </div>
      <div className="morrow-routines__editor-fields">
        <label className="morrow-field">
          <span className="morrow-field__label">Name</span>
          <input
            aria-label="Routine name"
            className="morrow-field__input"
            maxLength={120}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            value={draft.name}
          />
        </label>
        <label className="morrow-field">
          <span className="morrow-field__label">Purpose</span>
          <textarea
            aria-label="Purpose"
            className="morrow-field__input morrow-field__textarea"
            maxLength={4000}
            onChange={(event) => onChange({ ...draft, objective: event.target.value })}
            rows={3}
            value={draft.objective}
          />
        </label>
      </div>
      <fieldset className="morrow-routines__steps-fieldset">
        <legend>Observed steps</legend>
        {draft.steps.map((step, index) => (
          <div className="morrow-routines__step" key={`routine-step-${index}`}>
            <label className="morrow-field">
              <span className="morrow-field__label">Step {index + 1}</span>
              <input
                aria-label={`Routine step ${index + 1}`}
                className="morrow-field__input"
                maxLength={240}
                onChange={(event) => updateStep(index, { summary: event.target.value })}
                value={step.summary}
              />
            </label>
            <label className="morrow-field">
              <span className="morrow-field__label">Target</span>
              <input
                aria-label={`Routine target ${index + 1}`}
                className="morrow-field__input"
                maxLength={500}
                onChange={(event) => updateStep(index, { target: event.target.value || null })}
                value={step.target ?? ""}
              />
            </label>
            <button
              aria-label={`Remove routine step ${index + 1}`}
              className="morrow-routines__remove-step"
              onClick={() => onChange({ ...draft, steps: draft.steps.filter((_, stepIndex) => stepIndex !== index) })}
              type="button"
            >
              <Trash2 aria-hidden="true" size={13} />
            </button>
          </div>
        ))}
        <button
          className="morrow-routines__add-step"
          disabled={draft.steps.length >= 200}
          onClick={() => onChange({ ...draft, steps: [...draft.steps, { summary: "Describe the next step", target: null, toolName: null }] })}
          type="button"
        >
          <Plus aria-hidden="true" size={13} />
          Add observed step
        </button>
      </fieldset>
      <div className="morrow-routines__editor-actions">
        <button onClick={onCancel} type="button"><X aria-hidden="true" size={13} />Cancel</button>
        <button disabled={!draft.name.trim() || !draft.objective.trim() || saving} onClick={onSave} type="button">
          <Save aria-hidden="true" size={13} />
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </li>
  );
}

/** The teammate a routine belongs to, resolved through the roster. */
function RoutineOwner({ agentId, projectId }: { agentId: string | null; projectId: string }) {
  const teammate = useThreadTeammate(projectId, agentId);
  return <TeammateAvatar isDefault={agentId === null} name={teammate?.name ?? "Morrow"} size="sm" />;
}
