import { Surface } from "@morrow/ui";
import { Link } from "@tanstack/react-router";

/**
 * Shown for any address the app does not recognise.
 *
 * The router had no not-found component, so a stale bookmark, a mistyped path,
 * or a link to an area that exists in the product map but is not built yet
 * (Memory) rendered the shell around an empty content region: no heading, no
 * explanation, and no way back. A page with no heading is also a dead end for
 * screen-reader users navigating by landmark.
 */
export function NotFoundPage() {
  return (
    <section aria-labelledby="not-found-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Not found</p>
        <h1 id="not-found-heading">That page isn’t here</h1>
        <p>The address may be out of date, or that part of Morrow may not be built yet.</p>
      </div>
      <Surface padding="large">
        <h2>Where to go next</h2>
        <p>Everything Morrow can do today is reachable from the sidebar.</p>
        <p>
          <Link to="/">Go to Home</Link>
        </p>
      </Surface>
    </section>
  );
}
