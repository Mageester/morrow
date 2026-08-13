import type { Conversation, WebMissionSummary } from "@morrow/contracts";
import { Button, StatusPill, Surface } from "@morrow/ui";
import { providerQueries } from "../../api/providers.js";
import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessageSquare, Workflow } from "lucide-react";
import { conversationQueries } from "../../api/conversations.js";
import { missionQueries } from "../../api/query-keys.js";
import { StateScene } from "../../components/product-frame.js";
import { ApiClientError } from "../../api/client.js";
import { teamApi } from "../../api/teams.js";
import { resultStateForDelegation } from "../shared/result-state.js";
import { useActiveProject } from "../projects/use-active-project.js";
import { GettingStarted } from "../onboarding/getting-started.js";
import { HomeComposer } from "./home-composer.js";
import type { ChatComposerModelRoute } from "../chat/chat-composer.js";

const ACTIVE_MISSION_STATES = new Set([
  "draft",
  "working",
  "reviewing",
  "needs_input",
  "blocked",
]);

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

export function HomePage() {
  const projects = useActiveProject();
  const providers = useQuery(providerQueries.list());
  const activeProject = projects.activeProject;
  const conversations = useQuery({
    ...conversationQueries.list(activeProject?.id ?? "", false),
    enabled: Boolean(activeProject),
  });
  const missions = useQuery({
    ...missionQueries.list(activeProject?.id ?? ""),
    enabled: Boolean(activeProject),
  });

  const recent = (conversations.data ?? [])
    .filter((conversation) => !conversation.archived)
    .slice(0, 6);
  const activeMissions = (missions.data ?? []).filter((mission) =>
    ACTIVE_MISSION_STATES.has(mission.state),
  );

  const homeRoutes = (providers.data ?? []).flatMap((provider): ChatComposerModelRoute[] => {
    if (!provider.configured || provider.id === "mock") return [];
    const models = provider.models.length > 0
      ? provider.models
      : provider.defaultModel
        ? [provider.defaultModel]
        : [];
    return models.map((model) => ({
      id: `model:${provider.id}:${model}`,
      label: model,
      model,
      providerId: provider.id,
    }));
  });
  const defaultRoute = homeRoutes.find((route) =>
    (providers.data ?? []).some((provider) => provider.id === route.providerId && provider.defaultModel === route.model),
  );

  return (
    <section aria-labelledby="home-heading" className="morrow-page morrow-home">
      <header className="morrow-home__intro">
        <p className="morrow-product-eyebrow">{greeting(new Date())}</p>
        <h1 id="home-heading">
          {activeProject ? "What should we move forward?" : "A quieter place for ambitious work."}
        </h1>
        <p className="morrow-home__subtitle">
          {activeProject
            ? "Start with an outcome. Morrow will shape the work around you."
            : "Choose a local project and Morrow will anchor its work there."}
        </p>
        {/* The missing-provider prompt deliberately lives only in the setup
            checklist below. Repeating it here would put two identical "Connect
            a model" calls to action on one screen — the exact regression the
            checklist was introduced to remove. */}
        <HomeComposer initialRoute={defaultRoute} projectId={activeProject?.id} routes={homeRoutes} />
      </header>

      {/* Setup guidance sits above every other state. The branch below only
          prompted for a model inside the "no project yet" case, so an install
          with a project and no connected provider was sent straight to a
          composer where every send failed. */}
      <GettingStarted />

      {projects.isPending ? (
        <p aria-live="polite" role="status">
          Getting your workspace ready…
        </p>
      ) : projects.isError ? (
        <div className="morrow-inline-error">
          <p role="alert">Morrow could not reach your local workspace.</p>
          <button onClick={() => void projects.refetch()} type="button">
            Try again
          </button>
        </div>
      ) : projects.needsSelection ? (
        <StateScene
          action={<Link className="morrow-home__primary-action" to="/projects">Choose a local project</Link>}
          description={projects.staleSelection
            ? "The project Morrow last used here is no longer available."
            : "Choose which local project Morrow should work in."}
          title={projects.staleSelection ? "Your project selection needs a refresh" : "Select a project"}
        />
      ) : !activeProject ? (
        <StateScene
          action={<Link className="morrow-home__primary-action" to="/projects">Choose a local project</Link>}
          description="Choose a folder already on this machine. Morrow keeps its conversations, memory, and work anchored there."
          title="Your work begins with a place"
        >
          <p className="morrow-home__local-note">Local by default · yours to inspect</p>
        </StateScene>
      ) : (
        <>
          <ContinueSection projectId={activeProject.id} query={conversations} recent={recent} />
          {activeMissions.length > 0 ? (
            <ActiveWorkSection missions={activeMissions} />
          ) : null}
          <SampleTaskSection projectId={activeProject.id} />
        </>
      )}
    </section>
  );
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

/**
 * The onboarding mission's step 6: "run a safe deterministic sample task."
 * Local, no-network, no live model — Researcher reads README.md, Verifier
 * checks the result, and the full evidence trail (acceptance criteria,
 * artifact hash, verification note) renders right here, not just a "done"
 * toast.
 */
function SampleTaskSection({ projectId }: { projectId: string }) {
  const runSample = useMutation({
    mutationFn: () => teamApi.runReadmeSummarySample(projectId),
  });

  return (
    <Surface aria-labelledby="sample-task-heading" className="morrow-home__sample-task" padding="large">
      <div className="morrow-section-head">
        <h2 id="sample-task-heading">Try a safe deterministic sample task</h2>
      </div>
      <p>
        Summarizes this project's README through a Researcher → Verifier handoff. Local only — no
        network request, no live model call, nothing written outside this evidence trail.
      </p>
      <Button
        disabled={runSample.isPending}
        onClick={() => runSample.mutate()}
        variant="secondary"
      >
        {runSample.isPending ? "Running…" : "Run sample task"}
      </Button>
      {runSample.isError ? (
        <p role="alert">{safeError(runSample.error, "The sample task could not run — is there a README.md in this project?")}</p>
      ) : null}
      {runSample.isSuccess ? (
        <div aria-live="polite" className="morrow-home__sample-result" role="status">
          {(() => {
            const info = resultStateForDelegation(
              runSample.data.delegation.status as "completed",
              runSample.data.handoff.acceptanceCriteriaStatus,
            );
            return <StatusPill variant={info.variant}>{info.label}</StatusPill>;
          })()}
          <p className="morrow-home__sample-result-summary">{runSample.data.handoff.resultSummary}</p>
          <ul aria-label="Acceptance criteria" className="morrow-home__sample-result-criteria">
            {runSample.data.handoff.acceptanceCriteriaStatus.map((criterion) => (
              <li data-met={criterion.met} key={criterion.criterion}>
                {criterion.met ? "✓" : "✗"} {criterion.criterion}
              </li>
            ))}
          </ul>
          {runSample.data.handoff.verificationEvidence ? (
            <p className="morrow-home__sample-result-evidence">{runSample.data.handoff.verificationEvidence}</p>
          ) : null}
        </div>
      ) : null}
    </Surface>
  );
}

function ContinueSection({
  projectId,
  query,
  recent,
}: {
  projectId: string;
  query: UseQueryResult<Conversation[], Error>;
  recent: Conversation[];
}) {
  return (
    <section aria-labelledby="home-continue-heading" className="morrow-home__section">
      <div className="morrow-section-head">
        <h2 id="home-continue-heading">Continue where you left off</h2>
        <Link className="morrow-section-head__link" to="/chats">
          All chats
        </Link>
      </div>
      {query.isPending ? (
        <p aria-live="polite" role="status">
          Loading your recent chats…
        </p>
      ) : query.isError ? (
        <div className="morrow-inline-error">
          <p role="alert">Your recent chats could not be loaded.</p>
          <button onClick={() => void query.refetch()} type="button">
            Try again
          </button>
        </div>
      ) : recent.length === 0 ? (
        <div className="morrow-empty morrow-empty--soft">
          <p>No conversations yet. Describe an outcome above and it will appear here.</p>
        </div>
      ) : (
        /* Three continuation cards, the first weighted. A living surface for
           picking work back up — not a card dashboard: no metrics, no chrome,
           each card is one destination. */
        <ul className="morrow-home__continuity">
          {recent.slice(0, 3).map((conversation, index) => (
            <li key={conversation.id}>
              <Link
                className="morrow-work-card"
                data-featured={index === 0 ? "true" : undefined}
                params={{ conversationId: conversation.id }}
                search={{ projectId }}
                to="/chats/$conversationId"
              >
                <span className="morrow-work-card__label">
                  {index === 0 ? "Last active" : formatWhen(conversation.updatedAt)}
                </span>
                <span className="morrow-work-card__title">{conversation.title}</span>
                <span className="morrow-work-card__body">
                  {index === 0 ? "Pick up where you stopped" : "Conversation"}
                </span>
                <span className="morrow-work-card__foot">
                  <span>{formatWhen(conversation.updatedAt)}</span>
                  <span aria-hidden="true">Open →</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActiveWorkSection({ missions }: { missions: WebMissionSummary[] }) {
  return (
    <section aria-labelledby="home-active-heading" className="morrow-home__section">
      <div className="morrow-section-head">
        <h2 id="home-active-heading">Active work</h2>
        <Link className="morrow-section-head__link" to="/missions">
          All missions
        </Link>
      </div>
      <ul className="morrow-home__missions">
        {missions.slice(0, 3).map((mission) => (
          <li key={mission.id}>
            <Link
              className="morrow-mission-row"
              params={{ missionId: mission.id }}
              to="/missions/$missionId"
            >
              <span className="morrow-mission-row__icon" aria-hidden="true">
                <Workflow size={16} strokeWidth={1.8} />
              </span>
              <span className="morrow-mission-row__body">
                <span className="morrow-mission-row__title">{mission.title}</span>
                <span className="morrow-mission-row__meta">
                  {mission.currentPhase}
                  {mission.totalMilestones > 0
                    ? ` · ${mission.completedMilestones}/${mission.totalMilestones} steps`
                    : ""}
                </span>
              </span>
              {mission.attentionCount > 0 ? (
                <span className="morrow-mission-row__attention">Needs you</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
