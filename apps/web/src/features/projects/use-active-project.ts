import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { projectQueries, type ProjectSelection } from "../../api/projects.js";
import { useActiveProjectSelection } from "../../state/active-project.js";

export interface UseActiveProjectResult {
  /** All projects the user has created. */
  projects: ProjectSelection[];
  /**
   * The explicitly selected project when it still exists, otherwise the
   * first-created project. Falling back keeps single-project setups working
   * exactly as before a selection is ever made.
   */
  activeProject: ProjectSelection | undefined;
  isPending: boolean;
  isError: boolean;
  refetch: UseQueryResult<ProjectSelection[], Error>["refetch"];
  selectProject: (projectId: string) => void;
}

export function useActiveProject(): UseActiveProjectResult {
  const { selectedProjectId, selectProject } = useActiveProjectSelection();
  const query = useQuery(projectQueries.list());
  const projects = query.data ?? [];
  const activeProject =
    (selectedProjectId ? projects.find((project) => project.id === selectedProjectId) : undefined) ??
    projects[0];

  return {
    activeProject,
    isError: query.isError,
    isPending: query.isPending,
    projects,
    refetch: query.refetch,
    selectProject,
  };
}
