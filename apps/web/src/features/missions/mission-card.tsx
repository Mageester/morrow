import type { WebMissionSummary } from "@morrow/contracts";
import { StatusPill } from "@morrow/ui";
import { Link } from "@tanstack/react-router";
import { missionStateLabels, missionStateVariant } from "./mission-state.js";

/**
 * Compact mission card shared by Home and Missions. Shows the objective as the
 * primary link, the current phase, and — only when the mission actually has
 * milestones — honest milestone progress.
 */
export function MissionCard({ mission }: { mission: WebMissionSummary }) {
  return (
    <article className="morrow-mission-card">
      <div className="morrow-mission-card__heading">
        <h3>
          <Link params={{ missionId: mission.id }} to="/missions/$missionId">
            {mission.title}
          </Link>
        </h3>
        <StatusPill variant={missionStateVariant(mission.state)}>
          {missionStateLabels[mission.state]}
        </StatusPill>
      </div>
      <p className="morrow-mission-card__phase">{mission.currentPhase}</p>
      {mission.latestActivity ? (
        <p className="morrow-mission-card__activity">{mission.latestActivity}</p>
      ) : null}
      {mission.totalMilestones > 0 ? (
        <p className="morrow-mission-card__milestones">
          {mission.completedMilestones} of {mission.totalMilestones} milestone
          {mission.totalMilestones === 1 ? "" : "s"} completed
        </p>
      ) : null}
    </article>
  );
}

export function MissionCardList({
  missions,
}: {
  missions: readonly WebMissionSummary[];
}) {
  return (
    <div className="morrow-mission-card-list">
      {missions.map((mission) => (
        <MissionCard key={mission.id} mission={mission} />
      ))}
    </div>
  );
}
