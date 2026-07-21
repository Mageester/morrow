import { Surface } from "@morrow/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { missionQueries } from "../../api/query-keys.js";
import { projectQueries } from "../../api/projects.js";
import { MissionComposer } from "./mission-composer.js";

const activeStates = new Set(["draft", "working", "reviewing"]);
const resultStates = new Set([
  "completed_verified",
  "completed_with_caveats",
]);

export function HomePage() {
  const projects = useQuery(projectQueries.list());
  const activeProject = projects.data?.[0];
  const missions = useQuery({
    ...missionQueries.list(activeProject?.id ?? ""),
    enabled: Boolean(activeProject),
  });
  const attention = (missions.data ?? []).filter(
    (mission) =>
      mission.attentionCount > 0 ||
      mission.state === "blocked" ||
      mission.state === "needs_input",
  );
  const active = (missions.data ?? []).filter(
    (mission) => activeStates.has(mission.state),
  );
  const results = (missions.data ?? []).filter((mission) =>
    resultStates.has(mission.state),
  );

  return (
    <section aria-labelledby="home-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Your private agent</p>
        <h1 id="home-heading">Home</h1>
        <p>Start and resume durable work with Morrow.</p>
      </div>
      <MissionComposer activeProjectId={activeProject?.id} />
      {projects.isPending ? <p role="status">Loading local projects…</p> : null}
      {projects.isError ? (
        <p role="alert">Projects could not be loaded.</p>
      ) : null}
      {!projects.isPending && !projects.isError && !activeProject ? (
        <Surface padding="large">
          <h2>No project is available yet.</h2>
          <p>Create or open a local project before asking Morrow to begin work.</p>
        </Surface>
      ) : null}
      {missions.isError ? <p role="alert">Missions could not be loaded.</p> : null}
      {attention.length > 0 ? (
        <MissionSection heading="Needs your attention" missions={attention} />
      ) : null}
      {active.length > 0 ? (
        <MissionSection heading="Active missions" missions={active} />
      ) : null}
      {results.length > 0 ? (
        <MissionSection heading="Recent results" missions={results} />
      ) : null}
      {missions.isSuccess && missions.data.length === 0 ? (
        <Surface padding="large">
          <h2>Start with an outcome.</h2>
          <p>
            Try “Summarize this week’s findings,” “Plan a product launch,” or
            “Review this workspace and recommend the next step.”
          </p>
        </Surface>
      ) : null}
    </section>
  );
}

function MissionSection({
  heading,
  missions,
}: {
  heading: string;
  missions: Array<{
    currentPhase: string;
    id: string;
    latestActivity: string | null;
    title: string;
  }>;
}) {
  return (
    <section aria-labelledby={`${heading}-heading`}>
      <h2 id={`${heading}-heading`}>{heading}</h2>
      <div>
        {missions.map((mission) => (
          <Surface key={mission.id} padding="medium">
            <h3>
              <Link
                params={{ missionId: mission.id }}
                to="/missions/$missionId"
              >
                {mission.title}
              </Link>
            </h3>
            <p>{mission.currentPhase}</p>
            {mission.latestActivity ? <p>{mission.latestActivity}</p> : null}
          </Surface>
        ))}
      </div>
    </section>
  );
}
