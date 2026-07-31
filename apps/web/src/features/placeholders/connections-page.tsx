import { Button, Surface } from "@morrow/ui";
import { useRuntimeStatus } from "../../state/runtime-status.js";

const statusCopy = {
  checking: "Checking the local Morrow runtime.",
  offline: "The local Morrow runtime is unavailable.",
  online: "The local Morrow runtime is connected.",
  reconnecting: "Reconnecting to the local Morrow runtime.",
} as const;

export function ConnectionsPage() {
  const { refresh, status } = useRuntimeStatus();

  return (
    <section aria-labelledby="connections-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Local runtime</p>
        <h1 id="connections-heading">Connections</h1>
        <p>Review connection availability without exposing credentials.</p>
      </div>
      <Surface aria-labelledby="runtime-heading" padding="large">
        <h2 id="runtime-heading">Morrow runtime</h2>
        <p aria-atomic="true" aria-live="polite" role="status">
          {statusCopy[status]}
        </p>
        <Button
          onClick={() => void refresh()}
          variant="secondary"
        >
          Check again
        </Button>
      </Surface>
    </section>
  );
}
