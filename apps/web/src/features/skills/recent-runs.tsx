import type { Routine, ScheduleRun, ScheduleRunStatus } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { scheduleQueries } from "../../api/schedules.js";

/**
 * What your routines did while you were not watching.
 *
 * Per-schedule history answers "how is this one doing" and requires you to
 * already suspect which one to open. This answers the question people actually
 * arrive with — did anything run, and did any of it break — so a failed
 * overnight routine is visible without hunting for it.
 */

// Plain words for the durable run states. "Needs you" and "Blocked" are the
// two that are worth interrupting someone for, so they carry the same tone as
// an outright failure rather than reading as ordinary progress.
const STATUS_COPY: Record<ScheduleRunStatus, { label: string; tone: "ok" | "bad" | "muted" }> = {
  claimed: { label: "Starting", tone: "muted" },
  queued: { label: "Queued", tone: "muted" },
  running: { label: "Running", tone: "muted" },
  waiting_for_approval: { label: "Needs you", tone: "bad" },
  completed: { label: "Finished", tone: "ok" },
  verified: { label: "Finished", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  blocked: { label: "Blocked", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

function whenText(run: ScheduleRun): string {
  const stamp = run.completedAt ?? run.startedAt ?? run.occurrenceAt;
  const elapsed = Date.now() - new Date(stamp).getTime();
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function RecentRuns({ projectId, routines }: { projectId: string; routines: Routine[] }) {
  const runs = useQuery(scheduleQueries.projectRuns(projectId));
  const nameFor = (routineId: string | null) =>
    routines.find((routine) => routine.id === routineId)?.name ?? "Routine";

  if (runs.isPending || runs.isError) return null;
  const recent = runs.data ?? [];
  if (recent.length === 0) return null;

  const failures = recent.filter((run) => STATUS_COPY[run.status]?.tone === "bad");

  return (
    <section aria-labelledby="recent-runs-heading" className="morrow-recent-runs">
      <div className="morrow-section-head">
        <h3 id="recent-runs-heading">Recent runs</h3>
        {failures.length > 0 ? (
          <span className="morrow-recent-runs__alert" role="status">
            {failures.length} need{failures.length === 1 ? "s" : ""} a look
          </span>
        ) : null}
      </div>
      <ul className="morrow-recent-runs__list">
        {recent.slice(0, 8).map((run) => {
          const status = STATUS_COPY[run.status] ?? { label: run.status, tone: "muted" as const };
          return (
            <li className="morrow-recent-runs__row" data-tone={status.tone} key={run.id}>
              <span className="morrow-recent-runs__name">{nameFor(run.routineId)}</span>
              <span className="morrow-recent-runs__status">{status.label}</span>
              <span className="morrow-recent-runs__when">{whenText(run)}</span>
              {run.errorMessage ? (
                <span className="morrow-recent-runs__error">{run.errorMessage}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
