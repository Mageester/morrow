import { Surface } from "@morrow/ui";
import { useParams } from "@tanstack/react-router";

export function MissionPage() {
  const { missionId } = useParams({ strict: false });

  return (
    <section aria-labelledby="mission-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Mission</p>
        <h1 id="mission-heading">Mission workspace</h1>
        <p>Mission ID: {missionId}</p>
      </div>
      <Surface padding="large">
        <h2>Workspace ready</h2>
        <p>Overview and live activity arrive in a later product slice.</p>
      </Surface>
    </section>
  );
}
