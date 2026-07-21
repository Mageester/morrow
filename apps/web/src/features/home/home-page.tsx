import { Surface } from "@morrow/ui";

export function HomePage() {
  return (
    <section aria-labelledby="home-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Your private agent</p>
        <h1 id="home-heading">Home</h1>
        <p>Start and resume durable work with Morrow.</p>
      </div>
      <Surface padding="large" variant="raised">
        <h2>Mission workspace ready</h2>
        <p>
          Mission creation arrives in the next product slice. This foundation
          keeps the experience local-first and provider-neutral.
        </p>
      </Surface>
    </section>
  );
}
