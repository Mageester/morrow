import { Surface } from "@morrow/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Circle } from "lucide-react";
import { pairingQueries } from "../../api/pairing.js";
import { projectQueries } from "../../api/projects.js";
import { providerQueries } from "../../api/providers.js";

interface Step {
  id: string;
  title: string;
  body: string;
  done: boolean;
  /** Optional steps are shown for discoverability but never hold back the
   * "you are ready" state — Morrow is usable without an account. */
  optional?: boolean;
  action: { label: string; to: "/connections" | "/projects" | "/pair" };
}

/**
 * First-run setup, on the first screen.
 *
 * Morrow had no onboarding surface in the web app at all: a fresh install
 * landed on an otherwise empty Home with a disabled "New chat" button, and
 * the only guidance appeared in one branch of the no-project empty state. An
 * install that HAD a project but no connected model got nothing — it went
 * straight to a composer whose every send failed.
 *
 * This is deliberately a checklist over real state rather than a wizard that
 * takes the screen over. Each step reads its own status from the same
 * endpoints the destination pages use, so it cannot claim a step is done when
 * it is not, it survives the user doing the steps in any order or out of
 * band (the CLI's `morrow onboard`, an env var), and it retires itself the
 * moment the required steps are satisfied instead of needing a "dismiss".
 */
export function GettingStarted() {
  const providers = useQuery(providerQueries.list());
  const projects = useQuery(projectQueries.list());
  const pairing = useQuery(pairingQueries.status());

  // Nothing is claimed until the underlying query has actually answered.
  // Rendering "not done" against a pending query would flash a setup card at
  // someone whose install is already configured.
  if (!providers.isSuccess || !projects.isSuccess) return null;

  const connectedProviders = providers.data.filter((provider) => provider.configured && provider.id !== "mock");
  const steps: Step[] = [
    {
      id: "model",
      title: "Connect a model",
      body: "Morrow works with 31 providers, including free tiers and fully local models. Your key is stored on this machine.",
      done: connectedProviders.length > 0,
      action: { label: "Connect a model", to: "/connections" },
    },
    {
      id: "project",
      title: "Add a project",
      body: "Point Morrow at a folder already on this machine. It only ever reads or changes files inside the project you pick.",
      done: projects.data.length > 0,
      action: { label: "Add a project", to: "/projects" },
    },
    {
      id: "account",
      title: "Link your Morrow account",
      body: "Optional, and only syncs billing and entitlement. Everything keeps running locally either way.",
      done: pairing.data?.status === "active",
      optional: true,
      action: { label: "Enter a pairing code", to: "/pair" },
    },
  ];

  const required = steps.filter((step) => !step.optional);
  if (required.every((step) => step.done)) return null;

  const remaining = required.filter((step) => !step.done).length;

  return (
    <Surface aria-labelledby="getting-started-heading" className="morrow-getting-started" padding="large">
      <div className="morrow-getting-started__head">
        <p className="morrow-eyebrow">Set up Morrow</p>
        <h2 id="getting-started-heading">
          {remaining === required.length ? "Two steps and you're running" : "One more step"}
        </h2>
        <p>This disappears on its own once Morrow is ready.</p>
      </div>
      <ol className="morrow-getting-started__steps">
        {steps.map((step) => (
          <li
            className="morrow-getting-started__step"
            data-done={step.done ? "true" : undefined}
            key={step.id}
          >
            <span aria-hidden="true" className="morrow-getting-started__mark">
              {step.done ? <Check size={15} strokeWidth={2.4} /> : <Circle size={15} strokeWidth={1.8} />}
            </span>
            <span className="morrow-getting-started__body">
              <span className="morrow-getting-started__title">
                {step.title}
                {step.optional ? <span className="morrow-getting-started__optional">Optional</span> : null}
              </span>
              <span className="morrow-getting-started__detail">{step.body}</span>
              {step.done ? (
                <span className="morrow-getting-started__status">Done</span>
              ) : (
                <Link className="morrow-getting-started__action" to={step.action.to}>
                  {step.action.label}
                </Link>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Surface>
  );
}
