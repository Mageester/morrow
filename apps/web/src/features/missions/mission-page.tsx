import type {
  WebAttentionRequest,
  WebMissionSnapshot,
} from "@morrow/contracts";
import { WebMissionSnapshotSchema } from "@morrow/contracts";
import { Button, ErrorCard, StatusPill, Surface } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api, ApiClientError } from "../../api/client.js";
import { useMissionStream } from "../../api/mission-stream.js";
import { missionKeys, missionQueries } from "../../api/query-keys.js";
import {
  ActionableErrorCard,
  toErrorCard,
} from "../../app/error-boundary.js";
import { MissionActivity } from "./mission-activity.js";
import {
  AttentionCard,
  AttentionResolutionCoordinator,
} from "./attention-card.js";
import { missionStateLabels, missionStateVariant } from "./mission-state.js";
import { ResultPanel } from "./result-tab.js";

const RECOVERY_KINDS = new Set<WebAttentionRequest["kind"]>([
  "blocker",
  "connection",
]);

const ACTIVE_STATES = new Set([
  "draft",
  "working",
  "reviewing",
  "needs_input",
  "blocked",
]);

const FINISHED_STATES = new Set([
  "completed_verified",
  "completed_with_caveats",
]);

// ── Elapsed time ─────────────────────────────────────────────────────────────

function formatElapsed(fromIso: string, now: number): string {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

// ── Recovery surface ─────────────────────────────────────────────────────────
// A mission that cannot continue leads with this card: what happened, what is
// saved, what to do next. The raw technical message stays available behind a
// disclosure instead of being the primary copy.

function splitTechnicalReason(explanation: string): {
  friendly: string;
  technical: string | null;
} {
  const marker = "Technical reason:";
  const index = explanation.indexOf(marker);
  if (index < 0) return { friendly: explanation, technical: null };
  return {
    friendly: explanation.slice(0, index).trim(),
    technical: explanation.slice(index + marker.length).trim() || null,
  };
}

function RecoveryCard({
  missionId,
  request,
}: {
  missionId: string;
  request: WebAttentionRequest;
}) {
  const queryClient = useQueryClient();
  const [requestError, setRequestError] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: () =>
      api.post(
        `/api/web/missions/${encodeURIComponent(missionId)}/retry`,
        {},
        WebMissionSnapshotSchema,
      ),
    onError: (error) => {
      setRequestError(
        error instanceof ApiClientError
          ? error.message
          : "The retry could not be started. Check the connection to the local runtime.",
      );
    },
    onSuccess: (snapshot) => {
      setRequestError(null);
      queryClient.setQueryData(missionKeys.detail(missionId), snapshot);
    },
  });

  const { friendly, technical } = splitTechnicalReason(request.explanation);
  const needsProvider = request.kind === "connection";

  return (
    <Surface
      aria-labelledby="mission-recovery-heading"
      className="morrow-mission-recovery"
      padding="large"
      role="region"
    >
      <div className="morrow-mission-recovery__body">
        <p className="morrow-mission-recovery__kind">
          {needsProvider ? "Setup needed" : "Paused"}
        </p>
        <h2 id="mission-recovery-heading">{request.title}</h2>
        <p>{friendly}</p>
        {request.recommendation ? (
          <p className="morrow-mission-recovery__recommendation">
            {request.recommendation}
          </p>
        ) : null}
        {requestError ? <p role="alert">{requestError}</p> : null}
        {technical ? (
          <details className="morrow-mission-recovery__technical">
            <summary>Technical details</summary>
            <p>{technical}</p>
          </details>
        ) : null}
      </div>
      <div className="morrow-mission-recovery__actions">
        {needsProvider ? (
          <Button asChild>
            <Link to="/connections">Connect a model</Link>
          </Button>
        ) : null}
        <Button
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
          variant={needsProvider ? "secondary" : "primary"}
        >
          {retry.isPending ? "Retrying…" : "Try again"}
        </Button>
      </div>
    </Surface>
  );
}

// ── Context rail ─────────────────────────────────────────────────────────────

const milestoneDotLabels: Record<string, string> = {
  pending: "Pending",
  running: "In progress",
  completed: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

function ContextRail({ snapshot }: { snapshot: WebMissionSnapshot }) {
  const { milestones, artifacts, summary } = snapshot;
  const done = milestones.filter((m) => m.state === "completed").length;

  return (
    <aside aria-label="Mission context" className="morrow-mission-rail">
      <Surface className="morrow-rail-card" padding="medium">
        <h2>Objective</h2>
        <p className="morrow-rail-card__body">{summary.objective}</p>
      </Surface>

      <Surface className="morrow-rail-card" padding="medium">
        <h2>
          Plan
          {milestones.length > 0 ? (
            <span className="morrow-rail-card__count">
              {done}/{milestones.length}
            </span>
          ) : null}
        </h2>
        {milestones.length === 0 ? (
          <p className="morrow-rail-card__empty">
            Morrow defines the success checklist as planning completes.
          </p>
        ) : (
          <ul className="morrow-rail-plan">
            {milestones.map((milestone) => (
              <li data-state={milestone.state} key={milestone.id}>
                <span aria-hidden="true" className="morrow-rail-plan__dot" />
                <span className="morrow-rail-plan__title">{milestone.title}</span>
                <span className="morrow-sr-only">
                  {milestoneDotLabels[milestone.state] ?? milestone.state}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Surface>

      <Surface className="morrow-rail-card" padding="medium">
        <h2>
          Deliverables
          {artifacts.length > 0 ? (
            <span className="morrow-rail-card__count">{artifacts.length}</span>
          ) : null}
        </h2>
        {artifacts.length === 0 ? (
          <p className="morrow-rail-card__empty">
            Files and reports appear here as Morrow produces them.
          </p>
        ) : (
          <ul className="morrow-rail-deliverables">
            {artifacts.map((artifact) => (
              <li key={`${artifact.id}:${artifact.version}`}>
                <span className="morrow-rail-deliverables__title">
                  {artifact.title.trim() || "Untitled artifact"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Surface>

      <Surface className="morrow-rail-card" padding="medium">
        <h2>Details</h2>
        <dl className="morrow-rail-details">
          <div>
            <dt>Model</dt>
            <dd>{summary.modelLabel}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>
              <time dateTime={summary.createdAt}>
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(summary.createdAt))}
              </time>
            </dd>
          </div>
          <div>
            <dt>Mission ID</dt>
            <dd className="morrow-rail-details__mono">{summary.id}</dd>
          </div>
        </dl>
      </Surface>
    </aside>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function MissionHeader({
  onStop,
  snapshot,
  stopPending,
  streamStatus,
  streamStatusMessage,
}: {
  onStop: () => void;
  snapshot: WebMissionSnapshot;
  stopPending: boolean;
  streamStatus: string;
  streamStatusMessage: string;
}) {
  const { summary } = snapshot;
  const active = ACTIVE_STATES.has(summary.state);
  const now = useNow(active);
  const showStop =
    summary.state === "working" ||
    summary.state === "reviewing" ||
    summary.state === "needs_input" ||
    summary.state === "draft";
  const [confirmingStop, setConfirmingStop] = useState(false);

  return (
    <header className="morrow-mission-topbar">
      <div className="morrow-mission-topbar__lead">
        <nav aria-label="Breadcrumb" className="morrow-mission-topbar__crumbs">
          <Link to="/missions">Missions</Link>
        </nav>
        <h1 id="mission-heading" title={summary.title}>
          {summary.title}
        </h1>
      </div>
      <div className="morrow-mission-topbar__meta">
        <StatusPill variant={missionStateVariant(summary.state)}>
          {missionStateLabels[summary.state]}
        </StatusPill>
        <span className="morrow-mission-topbar__phase">{summary.currentPhase}</span>
        <span aria-hidden="true" className="morrow-mission-topbar__sep">·</span>
        <span
          aria-label={`Elapsed time ${formatElapsed(summary.createdAt, now)}`}
          className="morrow-mission-topbar__fact"
        >
          {formatElapsed(summary.createdAt, now)}
        </span>
        <span aria-hidden="true" className="morrow-mission-topbar__sep">·</span>
        <span className="morrow-mission-topbar__fact">{summary.modelLabel}</span>
        <span
          aria-atomic="true"
          aria-live="polite"
          className="morrow-mission-sync"
          data-state={streamStatus}
          role="status"
        >
          <span aria-hidden="true" className="morrow-mission-sync__dot" />
          {streamStatusMessage}
        </span>
        {showStop ? (
          confirmingStop ? (
            <span className="morrow-mission-topbar__confirm">
              <Button
                disabled={stopPending}
                onClick={() => {
                  onStop();
                  setConfirmingStop(false);
                }}
                variant="danger"
              >
                {stopPending ? "Stopping…" : "Confirm stop"}
              </Button>
              <Button onClick={() => setConfirmingStop(false)} variant="ghost">
                Keep going
              </Button>
            </span>
          ) : (
            <Button onClick={() => setConfirmingStop(true)} variant="ghost">
              Stop
            </Button>
          )
        ) : null}
      </div>
    </header>
  );
}

// ── Errors and load states ───────────────────────────────────────────────────

function MissionLoadError({ error, retry }: { error: unknown; retry: () => void }) {
  const typed = error instanceof ApiClientError ? error : null;
  const notFound = typed?.status === 404 || typed?.code === "NOT_FOUND";

  return (
    <section aria-labelledby="mission-error-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Mission</p>
        <h1 id="mission-error-heading">
          {notFound ? "Mission not found" : "Mission could not be loaded"}
        </h1>
      </div>
      {notFound ? (
        <ErrorCard
          attempted={[]}
          continuation="Check again in case this mission is still available, or return to Missions to see current work."
          explanation="This mission is unavailable or no longer exists."
          preservedMessage="Your other missions are unaffected."
          recommendedAction={{ label: "Check again", onClick: retry }}
          title="Mission not found"
        />
      ) : (
        <ActionableErrorCard
          error={error}
          onRetry={retry}
          retryLabel="Retry mission"
        />
      )}
    </section>
  );
}

function MissionSynchronizationWarning({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const model = toErrorCard(error);
  return (
    <Surface
      aria-atomic="true"
      aria-label="Mission synchronization warning"
      aria-live="polite"
      className="morrow-mission-sync-warning"
      padding="medium"
      role="status"
      variant="subtle"
    >
      <div>
        <h2>Mission updates could not be synchronized.</h2>
        <p>
          {model.explanation}{" "}
          Showing the last synchronized state.
        </p>
      </div>
      <Button onClick={retry} variant="secondary">
        Retry synchronization
      </Button>
    </Surface>
  );
}

// ── Workspace ────────────────────────────────────────────────────────────────

interface MissionWorkspaceProps {
  retrySynchronization: () => void;
  snapshot: WebMissionSnapshot;
  synchronizationError: unknown | null;
}

function MissionWorkspace({
  retrySynchronization,
  snapshot,
  synchronizationError,
}: MissionWorkspaceProps) {
  const [announcement, setAnnouncement] = useState("");
  const queryClient = useQueryClient();
  const previous = useRef({
    activity: snapshot.summary.latestActivity,
    missionId: snapshot.summary.id,
    state: snapshot.summary.state,
  });
  const stream = useMissionStream(snapshot.summary.id);

  const stop = useMutation({
    mutationFn: () =>
      api.post(
        `/api/web/missions/${encodeURIComponent(snapshot.summary.id)}/stop`,
        {},
        WebMissionSnapshotSchema,
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(missionKeys.detail(snapshot.summary.id), next);
    },
  });

  useEffect(() => {
    const last = previous.current;
    if (last.missionId !== snapshot.summary.id) {
      previous.current = {
        activity: snapshot.summary.latestActivity,
        missionId: snapshot.summary.id,
        state: snapshot.summary.state,
      };
      setAnnouncement("");
      return;
    }

    const updates: string[] = [];
    if (last.state !== snapshot.summary.state) {
      updates.push(
        `Mission state changed to ${missionStateLabels[snapshot.summary.state]}.`,
      );
    }
    if (
      snapshot.summary.latestActivity &&
      last.activity !== snapshot.summary.latestActivity
    ) {
      updates.push(`Activity update: ${snapshot.summary.latestActivity}`);
    }
    previous.current = {
      activity: snapshot.summary.latestActivity,
      missionId: snapshot.summary.id,
      state: snapshot.summary.state,
    };
    if (updates.length > 0) setAnnouncement(updates.join(" "));
  }, [snapshot.summary.id, snapshot.summary.latestActivity, snapshot.summary.state]);

  const recovery = snapshot.attention.filter((request) =>
    RECOVERY_KINDS.has(request.kind),
  );
  const decisions = snapshot.attention.filter(
    (request) => !RECOVERY_KINDS.has(request.kind),
  );
  const finished = FINISHED_STATES.has(snapshot.summary.state);
  const failed = snapshot.summary.state === "failed";
  const cancelled =
    snapshot.summary.state === "cancelled" ||
    snapshot.summary.state === "superseded";
  const liveActivity = [...snapshot.recentActivity].reverse();

  return (
    <section aria-labelledby="mission-heading" className="morrow-page morrow-mission-page">
      <MissionHeader
        onStop={() => stop.mutate()}
        snapshot={snapshot}
        stopPending={stop.isPending}
        streamStatus={stream.status}
        streamStatusMessage={stream.statusMessage}
      />

      <p
        aria-atomic="true"
        aria-label="Mission updates"
        aria-live="polite"
        className="morrow-sr-only"
        role="status"
      >
        {announcement}
      </p>

      {synchronizationError ? (
        <MissionSynchronizationWarning
          error={synchronizationError}
          retry={retrySynchronization}
        />
      ) : null}

      {recovery.map((request) => (
        <RecoveryCard
          key={request.id}
          missionId={snapshot.summary.id}
          request={request}
        />
      ))}

      <div className="morrow-mission-columns">
        <div className="morrow-mission-main">
          {decisions.length > 0 ? (
            <AttentionResolutionCoordinator missionId={snapshot.summary.id}>
              <div aria-label="Waiting on you" className="morrow-mission-decisions" role="region">
                {decisions.map((request) => (
                  <AttentionCard
                    key={request.id}
                    missionId={snapshot.summary.id}
                    request={request}
                  />
                ))}
              </div>
            </AttentionResolutionCoordinator>
          ) : null}

          {finished || failed ? (
            <ResultPanel
              artifacts={snapshot.artifacts}
              missionState={snapshot.summary.state}
              verification={snapshot.verification}
            />
          ) : null}

          {cancelled ? (
            <Surface padding="large">
              <h2>Mission stopped</h2>
              <p>
                This mission was stopped before finishing. Everything recorded
                up to that point stays in the timeline below.
              </p>
            </Surface>
          ) : null}

          <Surface className="morrow-mission-stream" padding="large">
            <div className="morrow-mission-stream__heading">
              <h2>{finished ? "How this was done" : "Live progress"}</h2>
              <span className="morrow-mission-stream__phase">
                {snapshot.summary.currentPhase}
              </span>
            </div>
            {snapshot.currentWork && !finished ? (
              <p className="morrow-mission-stream__current">
                {snapshot.currentWork}
              </p>
            ) : null}
            <MissionActivity activity={liveActivity} embedded />
          </Surface>
        </div>

        <ContextRail snapshot={snapshot} />
      </div>
    </section>
  );
}

export function MissionPage() {
  const { missionId } = useParams({ strict: false });
  const mission = useQuery({
    ...missionQueries.detail(missionId ?? ""),
    enabled: Boolean(missionId),
  });

  if (mission.isPending) {
    return (
      <section aria-labelledby="mission-loading-heading" className="morrow-page">
        <div className="morrow-page__heading">
          <p className="morrow-eyebrow">Mission</p>
          <h1 id="mission-loading-heading">Mission workspace</h1>
        </div>
        <Surface padding="large">
          <p aria-live="polite" role="status">
            Loading mission…
          </p>
        </Surface>
      </section>
    );
  }

  if (mission.isError && !mission.data) {
    return (
      <MissionLoadError
        error={mission.error}
        retry={() => {
          void mission.refetch();
        }}
      />
    );
  }

  return (
    <MissionWorkspace
      retrySynchronization={() => {
        void mission.refetch();
      }}
      snapshot={mission.data}
      synchronizationError={mission.isError ? mission.error : null}
    />
  );
}
