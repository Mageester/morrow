import { Button, Surface } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiClientError } from "../../api/client.js";
import { projectApi, projectQueries, type ProjectSelection } from "../../api/projects.js";
import { useActiveProject } from "./use-active-project.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

export function ProjectsPage() {
  const { projects, activeProject, isPending, isError, refetch, selectProject } = useActiveProject();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [projectToDelete, setProjectToDelete] = useState<ProjectSelection | null>(null);

  const createProject = useMutation({
    mutationFn: () => projectApi.create({ name: name.trim(), workspacePath: workspacePath.trim() }),
    onSuccess: (created) => {
      setName("");
      setWorkspacePath("");
      selectProject(created.id);
      void queryClient.invalidateQueries({ queryKey: ["projects", "available"] });
    },
  });

  const deleteProject = useMutation({
    mutationFn: (id: string) => projectApi.delete(id),
    onSuccess: (_, deletedId) => {
      setProjectToDelete(null);
      if (activeProject?.id === deletedId) {
        const remaining = projects.filter((p) => p.id !== deletedId);
        if (remaining.length > 0) {
          selectProject(remaining[0]!.id);
        } else {
          localStorage.removeItem("morrow-active-project");
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["projects", "available"] });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !workspacePath.trim() || createProject.isPending) return;
    createProject.mutate();
  }

  return (
    <section aria-labelledby="projects-heading" className="morrow-page morrow-projects">
      <div className="morrow-page__heading">
        <h1 id="projects-heading">Projects</h1>
        <p>
          Point Morrow at a repository already on this machine. Chats and missions only ever read
          or change files inside the project you select here.
        </p>
        {activeProject ? (
          <Link className="morrow-projects__open-build" to="/chats">
            Open {activeProject.name} in Build
          </Link>
        ) : null}
      </div>

      <Surface aria-labelledby="projects-add-heading" className="morrow-projects__create">
        <h2 id="projects-add-heading">Add a project</h2>
        <p className="morrow-projects__create-note">
          The folder stays on this machine. Morrow registers it as an execution workspace — nothing
          is uploaded.
        </p>
        <form className="morrow-projects__form" onSubmit={submit}>
          <label className="morrow-projects__field">
            <span>Project name</span>
            <input
              maxLength={120}
              name="project-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="My app"
              value={name}
            />
          </label>
          <label className="morrow-projects__field">
            <span>Folder path</span>
            <input
              name="project-path"
              onChange={(event) => setWorkspacePath(event.target.value)}
              placeholder="C:\code\my-app"
              value={workspacePath}
            />
          </label>
          <Button disabled={!name.trim() || !workspacePath.trim() || createProject.isPending} type="submit">
            {createProject.isPending ? "Adding…" : "Add project"}
          </Button>
        </form>
        {createProject.isError ? (
          <p role="alert">
            {safeError(createProject.error, "Morrow could not add this project. Check the path exists and try again.")}
          </p>
        ) : null}
      </Surface>

      {isPending ? (
        <p aria-live="polite" role="status">
          Loading your projects…
        </p>
      ) : isError ? (
        <div className="morrow-inline-error">
          <p role="alert">Your projects could not be loaded.</p>
          <button onClick={() => void refetch()} type="button">
            Try again
          </button>
        </div>
      ) : projects.length === 0 ? (
        <div className="morrow-empty">
          <h2>No projects yet</h2>
          <p>Add a project above and Morrow will start working there.</p>
        </div>
      ) : (
        <ul aria-label="Your projects" className="morrow-projects__list">
          {projects.map((project) => (
            <ProjectRow
              isActive={project.id === activeProject?.id}
              key={project.id}
              onDelete={() => setProjectToDelete(project)}
              onSelect={() => selectProject(project.id)}
              project={project}
            />
          ))}
        </ul>
      )}

      {projectToDelete ? (
        <div className="morrow-conversation-dialog-backdrop">
          <div aria-labelledby="delete-dialog-title" role="dialog" className="morrow-dialog">
            <h2 id="delete-dialog-title">Remove {projectToDelete.name}?</h2>
            <p>
              This will remove <strong>{projectToDelete.name}</strong> from Morrow’s project list.
              Your local files on disk will stay untouched.
            </p>
            {deleteProject.isError ? (
              <p role="alert" style={{ color: "var(--morrow-danger)" }}>
                {safeError(deleteProject.error, "Failed to delete project.")}
              </p>
            ) : null}
            <div className="morrow-dialog__actions" style={{ display: "flex", gap: "var(--morrow-space-2)", justifyContent: "flex-end", marginTop: "var(--morrow-space-4)" }}>
              <Button
                disabled={deleteProject.isPending}
                onClick={() => setProjectToDelete(null)}
                variant="secondary"
              >
                Cancel
              </Button>
              <Button
                disabled={deleteProject.isPending}
                onClick={() => deleteProject.mutate(projectToDelete.id)}
                variant="primary"
              >
                {deleteProject.isPending ? "Removing…" : "Remove Project"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProjectRow({
  isActive,
  onDelete,
  onSelect,
  project,
}: {
  isActive: boolean;
  onDelete: () => void;
  onSelect: () => void;
  project: ProjectSelection;
}) {
  const status = useQuery(projectQueries.status(project.id));

  return (
    <li className="morrow-projects__row" data-active={isActive || undefined}>
      <div className="morrow-projects__row-main">
        <span className="morrow-projects__row-name">{project.name}</span>
        {isActive ? <span className="morrow-projects__row-badge">Active</span> : null}
      </div>
      <div className="morrow-projects__row-detail">
        {status.isPending ? (
          <span aria-live="polite" className="morrow-projects__row-path" role="status">
            Checking workspace…
          </span>
        ) : status.isError || !status.data ? (
          <span className="morrow-projects__row-path" role="alert">
            Workspace status unavailable.
          </span>
        ) : (
          <>
            <span className="morrow-projects__row-path" title={status.data.workspacePath}>
              {status.data.workspacePath}
            </span>
            {!status.data.accessible ? (
              <span className="morrow-projects__row-blocker" role="alert">
                Folder is not accessible right now
              </span>
            ) : status.data.gitDetected ? (
              <span className="morrow-projects__row-branch">{status.data.branch ?? "detached HEAD"}</span>
            ) : (
              <span className="morrow-projects__row-branch morrow-projects__row-branch--none">
                No Git repository detected
              </span>
            )}
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: "var(--morrow-space-2)", alignItems: "center" }}>
        {!isActive ? (
          <Button onClick={onSelect} size="compact" variant="secondary">
            Use this project
          </Button>
        ) : null}
        <button
          aria-label={`Delete ${project.name}`}
          className="morrow-icon-button"
          onClick={onDelete}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--morrow-text-muted)",
            cursor: "pointer",
            padding: "var(--morrow-space-1)",
            borderRadius: "var(--morrow-radius-sm)",
          }}
          title="Remove project"
          type="button"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </li>
  );
}

