import { Button, EmptyState, StatusPill, Surface } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiClientError } from "../../api/client.js";
import { teamApi, teamQueries } from "../../api/teams.js";
import { ProductHeader } from "../../components/product-frame.js";
import { useActiveProject } from "../projects/use-active-project.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

const TEAM_STATUS_VARIANT: Record<string, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  active: "success",
  paused: "warning",
  archived: "neutral",
};

export function TeamsPage() {
  const { activeProject } = useActiveProject();
  const queryClient = useQueryClient();
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);

  const teams = useQuery({ ...teamQueries.list(activeProject?.id ?? ""), enabled: Boolean(activeProject) });

  const createTeam = useMutation({
    mutationFn: () => teamApi.createFromPreset(activeProject!.id, { preset: "research_and_verify" }),
    onSuccess: (created) => {
      setExpandedTeamId(created.team.id);
      void queryClient.invalidateQueries({ queryKey: ["teams", "list", activeProject?.id] });
    },
  });

  return (
    <section aria-labelledby="teams-heading" className="morrow-page morrow-teams">
      <ProductHeader
        description="A team is a durable, inspectable pair of named specialists—not an invisible subagent that multiplies model calls. Every team's effective policy is visible before it ever runs."
        eyebrow="Persistent agent teams"
        headingId="teams-heading"
        title="Teams"
      />

      {!activeProject ? (
        <EmptyState
          description="Choose a project before creating a team."
          title="No project selected"
        />
      ) : teams.isPending ? (
        <p aria-live="polite" role="status">
          Loading teams…
        </p>
      ) : teams.isError ? (
        <div className="morrow-inline-error">
          <p role="alert">Teams could not be loaded.</p>
          <button onClick={() => void teams.refetch()} type="button">
            Try again
          </button>
        </div>
      ) : (teams.data ?? []).length === 0 ? (
        <EmptyState
          action={{ label: createTeam.isPending ? "Creating…" : "Create Research & verify team", onClick: () => createTeam.mutate() }}
          description="Researcher (read-only, bounded sources) hands off to Verifier (checks the work, writes only the approved artifact). This is the only preset available in this slice."
          title="No teams yet"
        />
      ) : (
        <>
          <div className="morrow-teams__toolbar">
            <Button disabled={createTeam.isPending} onClick={() => createTeam.mutate()} variant="secondary">
              {createTeam.isPending ? "Creating…" : "+ Research & verify team"}
            </Button>
          </div>
          {createTeam.isError ? (
            <p role="alert">{safeError(createTeam.error, "Could not create the team.")}</p>
          ) : null}
          <ul aria-label="Teams" className="morrow-teams__list">
            {(teams.data ?? []).map((team) => (
              <li key={team.id}>
                <Surface className="morrow-teams__row">
                  <button
                    aria-expanded={expandedTeamId === team.id}
                    className="morrow-teams__row-toggle"
                    onClick={() => setExpandedTeamId(expandedTeamId === team.id ? null : team.id)}
                    type="button"
                  >
                    <span className="morrow-teams__row-main">
                      <strong>{team.name}</strong>
                      <StatusPill variant={TEAM_STATUS_VARIANT[team.status] ?? "neutral"}>{team.status}</StatusPill>
                    </span>
                    <span className="morrow-teams__row-purpose">{team.purpose ?? "No purpose set."}</span>
                  </button>
                  {expandedTeamId === team.id ? (
                    <TeamDetail projectId={activeProject.id} teamId={team.id} />
                  ) : null}
                </Surface>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function TeamDetail({ projectId, teamId }: { projectId: string; teamId: string }) {
  const detail = useQuery(teamQueries.detail(projectId, teamId));

  if (detail.isPending) {
    return (
      <p aria-live="polite" className="morrow-teams__detail-loading" role="status">
        Loading effective policy…
      </p>
    );
  }
  if (detail.isError || !detail.data) {
    return <p role="alert">Could not load this team's members and policy.</p>;
  }

  return (
    <div className="morrow-teams__detail">
      <h3>Effective policy — inspect before it runs</h3>
      <p className="morrow-teams__detail-note">
        Shared memory: <strong>{detail.data.team.sharedMemoryPolicy}</strong> · Sequential execution only
        (concurrency {detail.data.team.defaultConcurrencyLimit}) · Approval required by default:{" "}
        <strong>{detail.data.team.defaultApprovalRequired ? "yes" : "no"}</strong>
      </p>
      <ul aria-label="Team members" className="morrow-teams__members">
        {detail.data.members.map((agent) => (
          <li className="morrow-teams__member" key={agent.id}>
            <div className="morrow-teams__member-head">
              <strong>{agent.name}</strong>
              <span className="morrow-teams__member-role">{agent.role}</span>
            </div>
            <dl className="morrow-teams__member-policy">
              <div>
                <dt>Reads</dt>
                <dd>{agent.memoryReadScopes.length ? agent.memoryReadScopes.join(", ") : "none"}</dd>
              </div>
              <div>
                <dt>Writes</dt>
                <dd>{agent.memoryWriteScopes.length ? agent.memoryWriteScopes.join(", ") : "none"}</dd>
              </div>
              <div>
                <dt>Budget</dt>
                <dd>
                  {agent.maxProviderCalls ?? "∞"} calls · {agent.maxTokenBudget ?? "∞"} tokens ·{" "}
                  {agent.maxWallClockMs ? `${Math.round(agent.maxWallClockMs / 1000)}s` : "∞"}
                </dd>
              </div>
              <div>
                <dt>Approval</dt>
                <dd>{agent.approvalRequired ? "Required before running" : "Not required"}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
