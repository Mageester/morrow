import { Surface } from "@morrow/ui";

export function LibraryPage() {
  return (
    <section aria-labelledby="library-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Knowledge and results</p>
        <h1 id="library-heading">Library</h1>
        <p>Find reusable mission outputs and evidence.</p>
      </div>
      <Surface padding="large">
        <h2>Your library is ready</h2>
        <p>Artifacts will appear here after missions produce them.</p>
      </Surface>
    </section>
  );
}
