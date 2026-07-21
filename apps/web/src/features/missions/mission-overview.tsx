import type {
  WebAttentionRequest,
  WebMissionMilestone,
  WebMissionSnapshot,
} from "@morrow/contracts";
import { Surface } from "@morrow/ui";

const milestoneStateLabels: Record<WebMissionMilestone["state"], string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

function MilestoneList({ milestones }: { milestones: WebMissionMilestone[] }) {
  return (
    <ul className="morrow-mission-milestones">
      {milestones.map((milestone) => (
        <li key={milestone.id}>
          <span>{milestone.title}</span>
          <span
            className="morrow-mission-milestone-state"
            data-state={milestone.state}
          >
            {milestoneStateLabels[milestone.state]}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AttentionList({ attention }: { attention: WebAttentionRequest[] }) {
  if (attention.length === 0) {
    return <p>No attention is needed right now.</p>;
  }

  return (
    <ul className="morrow-mission-attention-list">
      {attention.map((request) => (
        <li key={request.id}>
          <strong>{request.title}</strong>
          <p>{request.explanation}</p>
          {request.recommendation ? (
            <p>
              <span className="morrow-sr-only">Recommendation: </span>
              {request.recommendation}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function MissionOverview({ snapshot }: { snapshot: WebMissionSnapshot }) {
  const completed = snapshot.milestones.filter(
    (milestone) => milestone.state === "completed",
  );
  const remaining = snapshot.milestones.filter(
    (milestone) =>
      milestone.state !== "completed" && milestone.state !== "skipped",
  );

  return (
    <div className="morrow-mission-overview">
      <Surface className="morrow-mission-overview__objective" padding="large">
        <h2>Objective</h2>
        <p>{snapshot.summary.objective}</p>
      </Surface>

      <p className="morrow-mission-milestone-count" aria-label="Milestone progress">
        {completed.length} completed · {remaining.length} remaining ·{" "}
        {snapshot.milestones.length} total
      </p>

      {snapshot.milestones.length === 0 ? (
        <Surface padding="large">
          <h2>Milestones</h2>
          <p>No milestones have been defined yet.</p>
        </Surface>
      ) : (
        <>
          <Surface padding="large">
            <h2>Completed</h2>
            {completed.length > 0 ? (
              <MilestoneList milestones={completed} />
            ) : (
              <p>No milestones have been completed yet.</p>
            )}
          </Surface>
          <Surface padding="large">
            <h2>Remaining milestones</h2>
            {remaining.length > 0 ? (
              <MilestoneList milestones={remaining} />
            ) : (
              <p>No milestones remain.</p>
            )}
          </Surface>
        </>
      )}

      <Surface padding="large">
        <h2>Current work</h2>
        <p>{snapshot.currentWork ?? "No current work is reported."}</p>
        <p className="morrow-mission-secondary-copy">
          Current phase: {snapshot.summary.currentPhase}
        </p>
      </Surface>

      <Surface padding="large">
        <h2>Attention needed</h2>
        <AttentionList attention={snapshot.attention} />
      </Surface>
    </div>
  );
}
