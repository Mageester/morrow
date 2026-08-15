import { Link } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { CommandPalette } from "../features/search/command-palette.js";
import { useActiveProject } from "../features/projects/use-active-project.js";
import { useShellTitle } from "./shell-title.js";

/**
 * The workspace topbar: a breadcrumb on the left, the search/command entry on
 * the right, and — below the rail's breakpoint — the navigation toggle.
 *
 * The breadcrumb carries the active workspace as a trailing segment
 * ("Morrow / Conversation · BrowserOS"). That information used to live in a
 * floating pill; folding it into the breadcrumb keeps it continuously visible
 * without a second competing surface, and it is still a link to /projects.
 */
export function ShellTopbar({
  navOpen,
  onToggleNav,
  routeTitle,
}: {
  navOpen: boolean;
  onToggleNav: () => void;
  routeTitle: string;
}) {
  const publishedTitle = useShellTitle();
  const { activeProject, isPending } = useActiveProject();
  const title = publishedTitle ?? routeTitle;
  const workspaceName = isPending
    ? "Checking workspace"
    : activeProject?.name ?? "No project selected";

  return (
    <header className="morrow-shell-context">
      <div className="morrow-shell-crumb">
        <button
          aria-controls="morrow-sidebar"
          aria-expanded={navOpen}
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          className="morrow-shell-crumb__menu"
          onClick={onToggleNav}
          type="button"
        >
          {navOpen ? <X aria-hidden="true" size={18} /> : <Menu aria-hidden="true" size={18} />}
        </button>
        <span className="morrow-shell-crumb__root">Morrow</span>
        <span aria-hidden="true" className="morrow-shell-crumb__sep">
          /
        </span>
        <strong className="morrow-shell-crumb__here">{title}</strong>
        {/* One link in every state with a stable accessible name, so assistive
            technology hears the same thing whether a project is chosen, still
            loading, or absent. */}
        <Link
          aria-label={`Current workspace: ${workspaceName}`}
          className="morrow-shell-crumb__workspace"
          data-state={isPending ? "loading" : activeProject ? "ready" : "empty"}
          to="/projects"
        >
          <span aria-hidden="true">·</span>
          <span>{workspaceName}</span>
        </Link>
      </div>
      <CommandPalette />
    </header>
  );
}
