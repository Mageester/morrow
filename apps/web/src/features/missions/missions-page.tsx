import { Surface } from "@morrow/ui";

export function MissionsPage() {
  return (
    <section aria-labelledby="missions-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Durable work</p>
        <h1 id="missions-heading">Missions</h1>
        <p>Review active, blocked, and completed missions in one place.</p>
      </div>
      <Surface padding="large">
        <h2>No missions to show yet</h2>
        <p>The mission list will use the typed local runtime boundary.</p>
      </Surface>
    </section>
  );
}
