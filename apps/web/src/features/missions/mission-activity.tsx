import type { WebMissionActivity } from "@morrow/contracts";
import { Surface } from "@morrow/ui";

function formatTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function TechnicalDetails({ activity }: { activity: WebMissionActivity }) {
  return (
    <dl className="morrow-mission-technical-details">
      <div>
        <dt>Actor</dt>
        <dd>{activity.actor.name}</dd>
      </div>
      {activity.artifactIds.length > 0 ? (
        <div>
          <dt>Artifact references</dt>
          <dd>
            <ul>
              {activity.artifactIds.map((artifactId) => (
                <li key={artifactId}>{artifactId}</li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
      <div>
        <dt>Event ID</dt>
        <dd>{activity.id}</dd>
      </div>
      <div>
        <dt>Cursor</dt>
        <dd>{activity.cursor}</dd>
      </div>
      <div>
        <dt>Recorded</dt>
        <dd>
          <time dateTime={activity.createdAt}>
            {formatTimestamp(activity.createdAt)}
          </time>
        </dd>
      </div>
    </dl>
  );
}

export function MissionActivity({
  activity,
  embedded = false,
}: {
  activity: WebMissionActivity[];
  /** Render the bare timeline for embedding inside an existing card. */
  embedded?: boolean;
}) {
  const body =
    activity.length === 0 ? (
      <p className="morrow-mission-activity__empty">
        Steps appear here as Morrow works.
      </p>
    ) : (
      <ol aria-label="Mission activity" className="morrow-mission-activity">
        {activity.map((item) => (
          <li key={item.id}>
            <details>
              <summary>
                <span className="morrow-mission-activity__summary">
                  {item.summary}
                </span>
                <time
                  className="morrow-mission-activity__time"
                  dateTime={item.createdAt}
                >
                  {formatTimestamp(item.createdAt)}
                </time>
              </summary>
              <TechnicalDetails activity={item} />
            </details>
          </li>
        ))}
      </ol>
    );

  if (embedded) return body;

  return (
    <Surface padding="large">
      <h2>Activity</h2>
      {body}
    </Surface>
  );
}
