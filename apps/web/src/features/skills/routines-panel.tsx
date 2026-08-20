import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiClientError } from "../../api/client.js";
import { routineApi, routineKeys, routineQueries } from "../../api/routines.js";
import { TeammateAvatar } from "../roster/teammate-avatar.js";
import { useThreadTeammate } from "../roster/use-thread-teammate.js";

/**
 * Routines a teammate was taught by demonstration.
 *
 * Kept beside Skills because they answer the same question — "what can be
 * repeated?" — but they are a different kind of thing and say so: a skill is a
 * method Morrow ships or proves out, a routine is a job one of your teammates
 * was shown once and can be asked to do again.
 */

function formatWhen(iso: string | null): string {
  if (!iso) return "never run";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "never run";
  return `last run ${new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

export function RoutinesPanel({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
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
      setError(cause instanceof ApiClientError ? cause.message : "That routine could not be started.");
    },
  });

  const remove = useMutation({
    mutationFn: (routineId: string) => routineApi.remove(routineId, projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: routineKeys.list(projectId) }),
  });

  const rows = routines.data ?? [];
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="routines-heading" className="morrow-routines">
      <div className="morrow-section-head">
        <h2 id="routines-heading">Routines</h2>
        <span>Taught by demonstration</span>
      </div>
      {error ? <p className="morrow-routines__error" role="alert">{error}</p> : null}
      <ul className="morrow-routines__list">
        {rows.map((routine) => (
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
        ))}
      </ul>
    </section>
  );
}

/** The teammate a routine belongs to, resolved through the roster. */
function RoutineOwner({ agentId, projectId }: { agentId: string | null; projectId: string }) {
  const teammate = useThreadTeammate(projectId, agentId);
  return <TeammateAvatar isDefault={agentId === null} name={teammate?.name ?? "Morrow"} size="sm" />;
}
