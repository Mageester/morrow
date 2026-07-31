import { Surface } from "@morrow/ui";

export interface ComingSoonPageProps {
  description: string;
  title: string;
}

export function ComingSoonPage({
  description,
  title,
}: ComingSoonPageProps) {
  const headingId = `${title.toLowerCase().replaceAll(" ", "-")}-heading`;

  return (
    <section aria-labelledby={headingId} className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Coming soon</p>
        <h1 id={headingId}>{title}</h1>
        <p>{description}</p>
      </div>
      <Surface padding="large">
        <h2>Foundation in place</h2>
        <p>This area will open as its local-first workflow becomes available.</p>
      </Surface>
    </section>
  );
}
