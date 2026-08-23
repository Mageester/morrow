import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentQueries, teammateTrustKeys, teammateTrustQueries, teammateTrustApi } from "../../api/agents.js";

/**
 * Which teammates this one may hand work to without stopping for approval.
 *
 * A delegation normally pauses for a one-shot decision every single time,
 * which is correct for the first handoff and unworkable for a team that is
 * supposed to get on with it. Checking a teammate here records that decision
 * once, for that pair. Everything else about the handoff is unchanged: the
 * target still runs under its own tools, memory, and budget, and a change to
 * the target's setup quietly retires the grant so the next handoff asks again.
 */
export function TeammateTrustSection({ projectId, agentId, agentName }: {
  projectId: string;
  agentId: string;
  agentName: string;
}) {
  const queryClient = useQueryClient();
  const agents = useQuery(agentQueries.list(projectId));
  const trust = useQuery(teammateTrustQueries.list(projectId));

  const invalidate = () => queryClient.invalidateQueries({ queryKey: teammateTrustKeys.list(projectId) });
  const allow = useMutation({
    mutationFn: (targetAgentId: string) =>
      teammateTrustApi.grant(projectId, { callerAgentId: agentId, targetAgentId, maxDepth: 1, maxChildren: 4 }),
    onSuccess: invalidate,
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) => teammateTrustApi.revoke(projectId, grantId),
    onSuccess: invalidate,
  });

  // A teammate cannot be handed its own work, and team members coordinate
  // through the team delegation flow instead of this one.
  const candidates = (agents.data ?? []).filter((candidate) =>
    candidate.id !== agentId && candidate.enabled && !candidate.teamId);
  const grants = trust.data?.grants ?? [];
  const grantFor = (targetAgentId: string) =>
    grants.find((grant) => grant.targetAgentId === targetAgentId
      && (grant.callerAgentId === agentId || grant.callerAgentId === null));

  if (agents.isPending || trust.isPending) {
    return <p role="status">Reading teammates…</p>;
  }
  if (agents.isError || trust.isError) {
    return <p role="alert">Teamwork settings could not be loaded.</p>;
  }
  if (candidates.length === 0) {
    return <small>Add another teammate to let {agentName} share work.</small>;
  }

  const busy = allow.isPending || revoke.isPending;
  const failed = allow.isError || revoke.isError;

  return (
    <fieldset aria-label="Work together without asking" className="morrow-trust">
      <legend>Work together without asking</legend>
      <small className="morrow-trust__hint">
        {agentName} can hand work straight to anyone checked here. Everyone else still
        waits for your approval, every time.
      </small>
      <ul className="morrow-trust__list">
        {candidates.map((candidate) => {
          const grant = grantFor(candidate.id);
          const projectWide = grant?.callerAgentId === null;
          return (
            <li className="morrow-trust__row" key={candidate.id}>
              <label>
                <input
                  checked={Boolean(grant)}
                  disabled={busy || projectWide}
                  onChange={(event) => {
                    if (event.target.checked) allow.mutate(candidate.id);
                    else if (grant) revoke.mutate(grant.id);
                  }}
                  type="checkbox"
                />
                <span className="morrow-trust__name">{candidate.name}</span>
                {projectWide ? (
                  <small className="morrow-trust__note">Allowed for every teammate in this project</small>
                ) : null}
              </label>
            </li>
          );
        })}
      </ul>
      {failed ? <p role="alert">That change did not save. Try again.</p> : null}
    </fieldset>
  );
}
