import { Button, Surface } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderOpen, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiClientError } from "../../api/client.js";
import { projectApi, projectQueries, type ProjectSelection } from "../../api/projects.js";
import { ProductHeader } from "../../components/product-frame.js";
import { useActiveProject } from "./use-active-project.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

export function ProjectsPage() {
  const { projects, activeProject, isPending, isError, refetch, selectProject } = useActiveProject();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [projectToDelete, setProjectToDelete] = useState<ProjectSelection | null>(null);
  // Adding a project is a deliberate act, not a form that occupies the page
  // ahead of the work already in it.
  const [adding, setAdding] = useState(false);

  const pickFolder = useMutation({
    mutationFn: projectApi.pickFolder,
    onSuccess: (selection) => {
      if (!selection.path) return;
      setWorkspacePath(selection.path);
      if (!nameEdited) setName(selection.name ?? "");
    },
  });

  const createProject = useMutation({
    mutationFn: () => projectApi.create({ name: name.trim(), workspacePath: workspacePath.trim() }),
    onSuccess: (created) => {
      setName("");
      setNameEdited(false);
      setWorkspacePath("");
      setAdding(false);
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
      <ProductHeader
        action={
          <Button
            aria-controls="projects-add-panel"
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
            variant={adding ? "secondary" : "primary"}
          >
            {adding ? "Close" : "＋ New project"}
          </Button>
        }
        description="Living contexts for everything Morrow helps you accomplish. Chats and missions only ever read or change files inside the project you select here."
        eyebrow="Your work"
        headingId="projects-heading"
        title="Projects"
      />

      {/* The workspace you are in, as a place to return to rather than a row in
          a list. Only rendered once a project is actually selected — an empty
          feature panel would be decoration. */}
      {activeProject && !adding ? (
        <ActiveProjectPanel activeProject={activeProject} />
      ) : null}

      {adding ? (
        <Surface aria-labelledby="projects-add-heading" className="morrow-projects__create" id="projects-add-panel">
        <h2 id="projects-add-heading">Add a project</h2>
        <p className="morrow-projects__create-note">
          The folder stays on this machine. Morrow registers it as an execution workspace — nothing
          is uploaded.
        </p>
        <form className="morrow-projects__form" onSubmit={submit}>
          <div className="morrow-projects__field">
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              maxLength={120}
              name="project-name"
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
              placeholder="My app"
              value={name}
            />
          </div>
          <div className="morrow-projects__field">
            <label htmlFor="project-path">Folder path</label>
            <span className="morrow-projects__path-control">
              <input
                id="project-path"
                name="project-path"
                onChange={(event) => setWorkspacePath(event.target.value)}
                placeholder="C:\code\my-app"
                value={workspacePath}
              />
              <Button
                disabled={pickFolder.isPending || createProject.isPending}
                onClick={() => pickFolder.mutate()}
                size="compact"
                type="button"
                variant="secondary"
              >
                <FolderOpen aria-hidden="true" size={16} />
                {pickFolder.isPending ? "Opening…" : "Choose folder"}
              </Button>
            </span>
          </div>
          <Button disabled={!name.trim() || !workspacePath.trim() || createProject.isPending || pickFolder.isPending} type="submit">
            {createProject.isPending ? "Adding…" : "Add project"}
          </Button>
        </form>
        {pickFolder.isError ? (
          <p role="alert">
            {safeError(pickFolder.error, "Morrow could not open the folder picker. Enter the path manually instead.")}
          </p>
        ) : null}
        {createProject.isError ? (
          <p role="alert">
            {safeError(createProject.error, "Morrow could not add this project. Check the path exists and try again.")}
          </p>
        ) : null}
        </Surface>
      ) : null}

      <div className="morrow-section-head">
        <h2>Project index</h2>
        <span>{projects.length} registered</span>
      </div>

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
          <p>Add a project and Morrow will start working there.</p>
        </div>
      ) : (
        /* A precise editorial index, not a card grid: signature, identity,
           location, state, and one way in. */
        <ul aria-label="Your projects" className="morrow-editorial-index">
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

      <aside className="morrow-principle">
        <b>Your workspaces stay local and legible.</b>
        <span>One active context leads; every other project remains a precise, inspectable entry.</span>
      </aside>

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
    <li className="morrow-editorial-row" data-active={isActive || undefined}>
      <span aria-hidden="true" className="morrow-editorial-row__signature">
        {project.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="morrow-editorial-row__identity">
        <b>{project.name}</b>
        <small>{isActive ? "Active workspace" : "Local workspace"}</small>
      </div>
      <span className="morrow-editorial-row__purpose">
        {status.isPending ? (
          <span aria-live="polite" role="status">Checking workspace…</span>
        ) : status.isError || !status.data ? (
          <span role="alert">Workspace status unavailable.</span>
        ) : (
          <span title={status.data.workspacePath}>{status.data.workspacePath}</span>
        )}
      </span>
      <span className="morrow-editorial-row__time">
        {/* Honest state: an inaccessible folder is never dressed as a branch. */}
        {status.data && !status.data.accessible ? (
          <span className="morrow-projects__row-blocker" role="alert">Not accessible</span>
        ) : status.data?.gitDetected ? (
          status.data.branch ?? "detached HEAD"
        ) : status.data ? (
          "No Git repository"
        ) : null}
      </span>
      <span className="morrow-editorial-row__actions">
        {!isActive ? (
          <Button aria-label={`Use this project: ${project.name}`} onClick={onSelect} size="compact" variant="secondary">
            Open
          </Button>
        ) : (
          <span className="morrow-projects__row-badge">Active</span>
        )}
        {/* Removal stays a quiet icon and still routes through confirmation. */}
        <button
          aria-label={`Remove ${project.name}`}
          className="morrow-editorial-row__remove"
          onClick={onDelete}
          title="Remove project"
          type="button"
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      </span>
    </li>
  );
}

/**
 * The workspace currently in use, given the weight of a place to return to.
 * Mirrors the reference's continuation panel; the ring is the one ambient form
 * the premium system allows inside a featured surface.
 */
function ActiveProjectPanel({ activeProject }: { activeProject: ProjectSelection }) {
  const status = useQuery(projectQueries.status(activeProject.id));

  return (
    <section aria-label={`Current project: ${activeProject.name}`} className="morrow-feature-panel">
      <p className="morrow-feature-panel__meta">Continue where you left off</p>
      <h2>{activeProject.name}</h2>
      <p>
        {status.data?.accessible === false
          ? "This folder is not accessible right now. Morrow will not read or change anything until it is."
          : "Conversations, memory, and work for this project stay anchored to this folder on this machine."}
      </p>
      <div className="morrow-feature-panel__foot">
        <span title={status.data?.workspacePath ?? undefined}>
          {status.data?.workspacePath ?? "Checking workspace…"}
        </span>
        {status.data?.gitDetected ? <span>{status.data.branch ?? "detached HEAD"}</span> : null}
        <Link className="morrow-feature-panel__open" to="/chats">
          Open project →
        </Link>
      </div>
    </section>
  );
}
