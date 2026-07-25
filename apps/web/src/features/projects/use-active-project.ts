import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { projectQueries, type ProjectSelection } from "../../api/projects.js";
import { useActiveProjectSelection } from "../../state/active-project.js";

export interface UseActiveProjectResult {
  /** All projects the user has created. */
  projects: ProjectSelection[];
  /**
   * The explicitly selected project when it still exists. With exactly one
   * project and no selection ever made, that sole project resolves too —
   * there is nothing ambiguous to choose between. With more than one
   * project, an unresolved or stale selection is left undefined rather than
   * silently substituting an unrelated project (`needsSelection` is set
   * instead) — this matters most once a mission is already tied to a
   * specific project.
   */
  activeProject: ProjectSelection | undefined;
  /** True once projects have loaded and the user must pick one deliberately. */
  needsSelection: boolean;
  /** The stored selection loaded but no longer matches a real project. */
  staleSelection: boolean;
  isPending: boolean;
  isError: boolean;
  refetch: UseQueryResult<ProjectSelection[], Error>["refetch"];
  selectProject: (projectId: string) => void;
}

export function useActiveProject(): UseActiveProjectResult {
  const { selectedProjectId, selectProject } = useActiveProjectSelection();
  const query = useQuery(projectQueries.list());
  const projects = query.data ?? [];
  const selected = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId)
    : undefined;
  const staleSelection = Boolean(selectedProjectId) && !selected && projects.length > 0;
  const soleProject = !selectedProjectId && projects.length === 1 ? projects[0] : undefined;
  const activeProject = selected ?? soleProject;
  const needsSelection = !activeProject && projects.length > 0;

  return {
    activeProject,
    isError: query.isError,
    isPending: query.isPending,
    needsSelection,
    projects,
    refetch: query.refetch,
    selectProject,
    staleSelection,
  };
}
