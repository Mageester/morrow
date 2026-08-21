import type { Routine, Schedule, ScheduleNotificationEvent, ScheduleRun } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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

const notificationEventOptions: Array<{ value: ScheduleNotificationEvent; label: string }> = [
  { value: "waiting_for_approval", label: "Notify when waiting for approval" },
  { value: "completed", label: "Notify when completed" },
  { value: "failed", label: "Notify when failed" },
  { value: "blocked", label: "Notify when blocked" },
];
const defaultNotificationEvents: ScheduleNotificationEvent[] = ["completed", "failed", "blocked"];

export function RoutineSchedulesPanel({ projectId, routines }: { projectId: string; routines: Routine[] }) {
  const schedules = useQuery(scheduleQueries.list(projectId));
  const [notificationOptionsRequested, setNotificationOptionsRequested] = useState(false);
  const notificationOptionsEnabled = notificationOptionsRequested || Boolean(schedules.data?.length);
  const notificationOptions = useQuery({
    ...scheduleQueries.notificationOptions(projectId),
    // Unscheduled rows start with the safe "all configured" default. Fetch
    // adapter metadata when a user opens that control, avoiding a second
    // request for every routine list that has no schedules yet.
    enabled: notificationOptionsEnabled,
  });
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
            notificationAdapters={notificationOptions.data?.adapters ?? []}
            notificationOptionsError={notificationOptions.isError}
            notificationOptionsEnabled={notificationOptionsEnabled}
            notificationOptionsPending={notificationOptionsEnabled && notificationOptions.isPending}
            onNotificationOptionsRequest={() => setNotificationOptionsRequested(true)}
          />
        ))}
      </ul>
    </section>
  );
}

function RoutineScheduleRow({
  projectId,
  routine,
  schedule,
  notificationAdapters,
  notificationOptionsError,
  notificationOptionsEnabled,
  notificationOptionsPending,
  onNotificationOptionsRequest,
}: {
  projectId: string;
  routine: Routine;
  schedule: Schedule | undefined;
  notificationAdapters: Array<{ id: string; channel: string }>;
  notificationOptionsError: boolean;
  notificationOptionsEnabled: boolean;
  notificationOptionsPending: boolean;
  onNotificationOptionsRequest: () => void;
}) {
  const queryClient = useQueryClient();
  const [cron, setCron] = useState(schedule?.cron ?? "0 9 * * 1-5");
  const [notificationEvents, setNotificationEvents] = useState<ScheduleNotificationEvent[]>(schedule?.notification.events ?? defaultNotificationEvents);
  const [notificationAdapterId, setNotificationAdapterId] = useState(schedule?.notification.adapterId ?? "");
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const adapterConfigured = notificationAdapterId === ""
    || notificationAdapters.some((adapter) => adapter.id === notificationAdapterId);
  const adapterSelectionUnknown = Boolean(notificationAdapterId)
    && !notificationAdapters.some((adapter) => adapter.id === notificationAdapterId)
    && (notificationOptionsError || (!notificationOptionsPending && !adapterConfigured));
  useEffect(() => {
    if (!schedule) return;
    setCron(schedule.cron);
    setNotificationEvents(schedule.notification.events);
    setNotificationAdapterId(schedule.notification.adapterId ?? "");
  }, [schedule?.id, schedule?.updatedAt]);
  const history = useQuery({ ...scheduleQueries.runs(projectId, schedule?.id ?? ""), enabled: showHistory && Boolean(schedule) });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: scheduleKeys.list(projectId) });
    if (schedule) void queryClient.invalidateQueries({ queryKey: scheduleKeys.runs(projectId, schedule.id) });
  };
  const mutation = useMutation({
    mutationFn: async (action: "create" | "update" | "pause" | "resume" | "run" | "remove") => {
      const notification = { events: notificationEvents, adapterId: notificationAdapterId || null };
      if (action === "create") return scheduleApi.create(projectId, { cron, routineId: routine.id, notification });
      if (!schedule) throw new Error("Schedule not found");
      if (action === "update") return scheduleApi.update(projectId, schedule.id, { cron, notification });
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
      <fieldset className="morrow-routine-schedules__notifications">
        <legend>Notifications</legend>
        {notificationEventOptions.map((option) => (
          <label key={option.value}>
            <input
              aria-label={option.label}
              checked={notificationEvents.includes(option.value)}
              onChange={(event) => {
                setNotificationEvents((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(option.value);
                  else next.delete(option.value);
                  return notificationEventOptions.filter((item) => next.has(item.value)).map((item) => item.value);
                });
              }}
              type="checkbox"
            />
            {option.label.replace(/^Notify when /, "")}
          </label>
        ))}
        <label>
          <span className="morrow-visually-hidden">Notification adapter</span>
          <select
            aria-label="Notification adapter"
            disabled={notificationOptionsPending}
            onChange={(event) => setNotificationAdapterId(event.target.value)}
            onFocus={onNotificationOptionsRequest}
            value={notificationAdapterId}
          >
            <option value="">All configured adapters</option>
            {adapterSelectionUnknown ? (
              <option value={notificationAdapterId}>
                {notificationOptionsError ? `Saved adapter unavailable to check (${notificationAdapterId})` : `Saved adapter removed (${notificationAdapterId})`}
              </option>
            ) : null}
            {notificationAdapters.map((adapter) => (
              <option key={adapter.id} value={adapter.id}>{adapter.id} ({adapter.channel})</option>
            ))}
          </select>
        </label>
        {notificationOptionsPending ? <small>Loading configured adapters…</small> : null}
        {!notificationOptionsPending && notificationOptionsError ? <small role="alert">Notification adapters are unavailable; the saved selection is retained.</small> : null}
        {!notificationOptionsPending && !notificationOptionsError && !adapterConfigured ? <small role="alert">The saved adapter is no longer configured. Choose All configured adapters.</small> : null}
        {notificationOptionsEnabled && !notificationOptionsPending && !notificationOptionsError && notificationAdapters.length === 0 ? <small>No messaging adapters configured.</small> : null}
      </fieldset>
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
