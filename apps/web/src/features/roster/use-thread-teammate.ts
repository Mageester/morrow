import type { RosterEntry } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { agentQueries } from "../../api/agents.js";

/**
 * Which teammate a thread belongs to.
 *
 * Read from the roster the rail is already polling rather than fetching the
 * agent separately: the roster is the one projection that knows both the named
 * agents and the built-in default teammate, so a thread with either resolves
 * through the same path and neither needs a special case at the call site.
 *
 * Returns `undefined` only while the roster is still loading or when the
 * binding names an agent that no longer exists — callers fall back to the
 * product's own voice rather than inventing a name.
 */
export function useThreadTeammate(
  projectId: string | undefined,
  agentId: string | null | undefined,
): RosterEntry | undefined {
  const roster = useQuery({ ...agentQueries.roster(projectId ?? ""), enabled: Boolean(projectId) });
  if (agentId === undefined) return undefined;
  return roster.data?.entries.find((entry) => entry.agentId === agentId);
}
