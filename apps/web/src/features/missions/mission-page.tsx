import type { WebMissionSnapshot, WebMissionUiState } from "@morrow/contracts";
import { Button, ErrorCard, Surface } from "@morrow/ui";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ApiClientError } from "../../api/client.js";
import { useMissionStream } from "../../api/mission-stream.js";
import { missionQueries } from "../../api/query-keys.js";
import { MissionActivity } from "./mission-activity.js";
import { MissionOverview } from "./mission-overview.js";
import { ResultTab } from "./result-tab.js";
import { WorkTab } from "./work-tab.js";

const tabs = ["Overview", "Activity", "Work", "Result"] as const;
type MissionTab = (typeof tabs)[number];

const missionStateLabels: Record<WebMissionUiState, string> = {
  draft: "Draft",
  needs_input: "Needs input",
  working: "Working",
  reviewing: "Reviewing",
  blocked: "Blocked",
  failed_recoverable: "Failed, recoverable",
  failed: "Failed",
  completed_verified: "Completed and verified",
  completed_with_caveats: "Completed with caveats",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

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
      <ErrorCard
        attempted={[]}
        continuation="Retry the authoritative mission snapshot when the local service is available."
        explanation={
          notFound
            ? "This mission is unavailable or no longer exists."
            : (typed?.message ?? "The request could not be completed.")
        }
        preservedMessage="Your synchronized mission data remains unchanged."
        recommendedAction={{ label: "Retry mission", onClick: retry }}
        title={notFound ? "Mission not found" : "Mission could not be loaded"}
      />
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
          {error instanceof ApiClientError
            ? error.message
            : "The latest mission state could not be loaded."}{" "}
          Showing the last synchronized state.
        </p>
      </div>
      <Button onClick={retry} variant="secondary">
        Retry synchronization
      </Button>
    </Surface>
  );
}

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
  const [activeTab, setActiveTab] = useState<MissionTab>("Overview");
  const [announcement, setAnnouncement] = useState("");
  const tabIdPrefix = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previous = useRef({
    activity: snapshot.summary.latestActivity,
    missionId: snapshot.summary.id,
    state: snapshot.summary.state,
  });
  const stream = useMissionStream(snapshot.summary.id);

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

  const activateTab = (index: number, moveFocus: boolean) => {
    const next = tabs[index];
    if (!next) return;
    setActiveTab(next);
    if (moveFocus) tabRefs.current[index]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = tabs.indexOf(activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTab(nextIndex, true);
  };

  return (
    <section aria-labelledby="mission-heading" className="morrow-page morrow-mission-page">
      <div className="morrow-mission-header">
        <div className="morrow-page__heading">
          <p className="morrow-eyebrow">Mission</p>
          <h1 id="mission-heading">{snapshot.summary.title}</h1>
        </div>
        <div className="morrow-mission-header__status">
          <span className="morrow-mission-state" data-state={snapshot.summary.state}>
            {missionStateLabels[snapshot.summary.state]}
          </span>
          <span>{snapshot.summary.currentPhase}</span>
          <span
            aria-atomic="true"
            aria-live="polite"
            className="morrow-mission-sync"
            data-state={stream.status}
            role="status"
          >
            {stream.statusMessage}
          </span>
        </div>
      </div>

      <p
        aria-atomic="true"
        aria-label="Mission updates"
        aria-live="polite"
        className="morrow-sr-only"
      >
        {announcement}
      </p>

      {synchronizationError ? (
        <MissionSynchronizationWarning
          error={synchronizationError}
          retry={retrySynchronization}
        />
      ) : null}

      <div aria-label="Mission views" className="morrow-mission-tabs" role="tablist">
        {tabs.map((tab, index) => {
          const selected = tab === activeTab;
          return (
            <button
              aria-controls={`${tabIdPrefix}-panel-${tab.toLowerCase()}`}
              aria-selected={selected}
              id={`${tabIdPrefix}-tab-${tab.toLowerCase()}`}
              key={tab}
              onClick={() => activateTab(index, false)}
              onKeyDown={handleTabKeyDown}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {tab}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => {
        const selected = tab === activeTab;
        return (
          <div
            aria-labelledby={`${tabIdPrefix}-tab-${tab.toLowerCase()}`}
            className="morrow-mission-panel"
            hidden={!selected}
            id={`${tabIdPrefix}-panel-${tab.toLowerCase()}`}
            key={tab}
            role="tabpanel"
            tabIndex={selected ? 0 : -1}
          >
            {tab === "Overview" ? <MissionOverview snapshot={snapshot} /> : null}
            {tab === "Activity" ? (
              <MissionActivity activity={snapshot.recentActivity} />
            ) : null}
            {tab === "Work" ? <WorkTab artifacts={snapshot.artifacts} /> : null}
            {tab === "Result" ? (
              <ResultTab
                artifacts={snapshot.artifacts}
                missionState={snapshot.summary.state}
                verification={snapshot.verification}
              />
            ) : null}
          </div>
        );
      })}
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
