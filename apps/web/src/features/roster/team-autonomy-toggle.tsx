import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { teamAutonomyApi, teamAutonomyKeys, teamAutonomyQueries } from "../../api/agents.js";

/**
 * One switch: may Morrow run its team while you are away?
 *
 * The per-pair checkboxes below this answer "may A hand work to B", which needs
 * a decision for every pair and excludes Morrow itself — so an orchestrator that
 * is meant to coordinate workers had to stop and ask for each hand-off it made.
 * This answers the question the user actually has, once.
 *
 * It is not a permissive mode. It is one explicit, bounded, revocable decision
 * shown with its limits, so what was agreed to is legible rather than implied.
 */
export function TeamAutonomyToggle({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const state = useQuery(teamAutonomyQueries.state(projectId));
  const invalidate = () => queryClient.invalidateQueries({ queryKey: teamAutonomyKeys.state(projectId) });

  const enable = useMutation({ mutationFn: () => teamAutonomyApi.grant(projectId), onSuccess: invalidate });
  const disable = useMutation({ mutationFn: () => teamAutonomyApi.revoke(projectId), onSuccess: invalidate });

  if (state.isPending) return <p role="status">Reading team settings…</p>;
  if (state.isError) return <p role="alert">Team settings could not be loaded.</p>;

  const enabled = state.data.enabled;
  const grant = state.data.grant;
  const busy = enable.isPending || disable.isPending;
  const failed = enable.isError || disable.isError;

  return (
    <section className="morrow-team-autonomy">
      <label className="morrow-team-autonomy__switch">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={() => (enabled ? disable.mutate() : enable.mutate())}
        />
        <span>Let Morrow run the team</span>
      </label>

      <p className="morrow-team-autonomy__detail">
        {enabled
          ? "Morrow hands work to your teammates without stopping to ask. Every hand-off is still recorded."
          : "Morrow asks you to approve every hand-off to a teammate."}
      </p>

      {enabled && grant ? (
        <ul className="morrow-team-autonomy__limits">
          {/* The limits are shown, not hidden, so what was agreed to is legible. */}
          <li>Stops after {grant.maxTotalTokens.toLocaleString("en-US")} tokens</li>
          <li>Up to {grant.maxChildren} workers at once</li>
          <li>Hand-offs at most {grant.maxDepth} deep</li>
        </ul>
      ) : null}

      {failed ? <p role="alert">That change did not save. Try again.</p> : null}
    </section>
  );
}
