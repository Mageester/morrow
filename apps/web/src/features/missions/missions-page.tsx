import type { WebMissionSummary } from "@morrow/contracts";
import { Surface } from "@morrow/ui";
import { useQuery } from "@tanstack/react-query";
import { missionQueries } from "../../api/query-keys.js";
import { useActiveProject } from "../projects/use-active-project.js";
import { MissionCardList } from "./mission-card.js";

const activeStates = new Set(["draft", "working", "reviewing"]);
const completedStates = new Set([
  "completed_verified",
  "completed_with_caveats",
]);

function needsAttention(mission: WebMissionSummary): boolean {
  return (
    mission.attentionCount > 0 ||
    mission.state === "blocked" ||
    mission.state === "needs_input" ||
    mission.state === "failed_recoverable"
  );
}

function MissionGroup({
  heading,
  headingId,
  missions,
}: {
  heading: string;
  headingId: string;
  missions: WebMissionSummary[];
}) {
  if (missions.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="morrow-mission-section">
      <h2 id={headingId}>{heading}</h2>
      <MissionCardList missions={missions} />
    </section>
  );
}

export function MissionsPage() {
  const projects = useActiveProject();
  const activeProject = projects.activeProject;
  const missions = useQuery({
    ...missionQueries.list(activeProject?.id ?? ""),
    enabled: Boolean(activeProject),
  });

  const all = missions.data ?? [];
  const attention = all.filter(needsAttention);
  const attentionIds = new Set(attention.map((mission) => mission.id));
  const active = all.filter(
    (mission) =>
      !attentionIds.has(mission.id) && activeStates.has(mission.state),
  );
  const completed = all.filter(
    (mission) =>
      !attentionIds.has(mission.id) && completedStates.has(mission.state),
  );
  const ended = all.filter(
    (mission) =>
      !attentionIds.has(mission.id) &&
      !activeStates.has(mission.state) &&
      !completedStates.has(mission.state),
  );

  return (
    <section aria-labelledby="missions-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Durable work</p>
        <h1 id="missions-heading">Missions</h1>
        <p>Review active, blocked, and completed missions in one place.</p>
      </div>
      {projects.isPending || (activeProject && missions.isPending) ? (
        <p aria-live="polite" role="status">
          Loading missions…
        </p>
      ) : null}
      {projects.isError ? (
        <p role="alert">Projects could not be loaded.</p>
      ) : null}
      {missions.isError ? (
        <p role="alert">Missions could not be loaded.</p>
      ) : null}
      {!projects.isPending && !projects.isError && !activeProject ? (
        <Surface padding="large">
          <h2>No local project yet</h2>
          <p>
            Create or open a local project before asking Morrow to begin work.
          </p>
        </Surface>
      ) : null}
      <MissionGroup
        heading="Needs your attention"
        headingId="missions-attention-heading"
        missions={attention}
      />
      <MissionGroup
        heading="In progress"
        headingId="missions-active-heading"
        missions={active}
      />
      <MissionGroup
        heading="Completed"
        headingId="missions-completed-heading"
        missions={completed}
      />
      <MissionGroup
        heading="Ended without a result"
        headingId="missions-ended-heading"
        missions={ended}
      />
      {missions.isSuccess && all.length === 0 ? (
        <Surface padding="large">
          <h2>No missions yet</h2>
          <p>
            Start your first mission from Home and it will appear here with its
            live status.
          </p>
        </Surface>
      ) : null}
    </section>
  );
}
