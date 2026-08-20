import type { Routine, Schedule, ScheduleRun } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiClientError } from "../../api/client.js";
import { scheduleApi, scheduleKeys, scheduleQueries } from "../../api/schedules.js";

function errorMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The schedule could not be changed.";
}

function runLabel(run: ScheduleRun): string {
  if (run.status === "waiting_for_approval") return "Waiting for approval";
  if (run.status === "blocked") return `Blocked${run.errorCode ? ` · ${run.errorCode}` : ""}`;
  return run.status.replaceAll("_", " ");
}

export function RoutineSchedulesPanel({ projectId, routines }: { projectId: string; routines: Routine[] }) {
  const schedules = useQuery(scheduleQueries.list(projectId));
  if (schedules.isPending || routines.length === 0) return null;
  return (
    <section aria-labelledby="routine-schedules-heading" className="morrow-routine-schedules">
      <div className="morrow-section-head">
        <h2 id="routine-schedules-heading">Scheduled routines</h2>
        <span>Runs with approvals required</span>
      </div>
      {schedules.isError ? <p className="morrow-routines__error" role="alert">Schedules could not be loaded.</p> : null}
      <ul className="morrow-routine-schedules__list">
        {routines.map((routine) => (
          <RoutineScheduleRow
            key={routine.id}
            projectId={projectId}
            routine={routine}
            schedule={schedules.data?.find((item) => item.routineId === routine.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function RoutineScheduleRow({ projectId, routine, schedule }: { projectId: string; routine: Routine; schedule: Schedule | undefined }) {
  const queryClient = useQueryClient();
  const [cron, setCron] = useState(schedule?.cron ?? "0 9 * * 1-5");
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = useQuery({ ...scheduleQueries.runs(projectId, schedule?.id ?? ""), enabled: showHistory && Boolean(schedule) });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: scheduleKeys.list(projectId) });
    if (schedule) void queryClient.invalidateQueries({ queryKey: scheduleKeys.runs(projectId, schedule.id) });
  };
  const mutation = useMutation({
    mutationFn: async (action: "create" | "update" | "pause" | "resume" | "run" | "remove") => {
      if (action === "create") return scheduleApi.create(projectId, { cron, routineId: routine.id });
      if (!schedule) throw new Error("Schedule not found");
      if (action === "update") return scheduleApi.update(projectId, schedule.id, { cron });
      if (action === "pause") return scheduleApi.pause(schedule.id, projectId);
      if (action === "resume") return scheduleApi.resume(schedule.id, projectId);
      if (action === "run") return scheduleApi.run(schedule.id, projectId);
      return scheduleApi.remove(schedule.id, projectId);
    },
    onSuccess: () => { setError(null); invalidate(); },
    onError: (cause) => setError(errorMessage(cause)),
  });

  return (
    <li className="morrow-routine-schedules__row">
      <span className="morrow-routine-schedules__body">
        <strong>{routine.name}</strong>
        <span>{schedule ? `${schedule.enabled ? "Active" : "Paused"} · ${schedule.cron}` : "Not scheduled"}</span>
      </span>
      <label className="morrow-routine-schedules__cron">
        <span className="morrow-visually-hidden">Cron for {routine.name}</span>
        <input aria-label={`Cron for ${routine.name}`} onChange={(event) => setCron(event.target.value)} value={cron} />
      </label>
      {!schedule ? (
        <button disabled={mutation.isPending} onClick={() => mutation.mutate("create")} type="button">Schedule</button>
      ) : (
        <>
          <button disabled={mutation.isPending} onClick={() => mutation.mutate("update")} type="button">Save</button>
          <button disabled={mutation.isPending} onClick={() => mutation.mutate(schedule.enabled ? "pause" : "resume")} type="button">
            {schedule.enabled ? "Pause" : "Resume"}
          </button>
          <button disabled={mutation.isPending} onClick={() => mutation.mutate("run")} type="button">Run now</button>
          <button disabled={mutation.isPending} onClick={() => mutation.mutate("remove")} type="button">Delete</button>
          <button aria-expanded={showHistory} onClick={() => setShowHistory((value) => !value)} type="button">History</button>
        </>
      )}
      {error ? <span className="morrow-routines__error" role="alert">{error}</span> : null}
      {showHistory ? (
        <ul aria-label={`${routine.name} schedule history`} className="morrow-routine-schedules__history">
          {(history.data ?? []).map((run) => <li key={run.id}>{runLabel(run)} · {new Date(run.occurrenceAt).toLocaleString()}</li>)}
          {history.isPending ? <li>Loading history…</li> : null}
          {!history.isPending && (history.data ?? []).length === 0 ? <li>No runs yet.</li> : null}
        </ul>
      ) : null}
    </li>
  );
}
