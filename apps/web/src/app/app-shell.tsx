import { StatusPill } from "@morrow/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Cable,
  Folder,
  Home,
  Library,
  Menu,
  MessageSquare,
  Settings,
  Sparkles,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { conversationQueries } from "../api/conversations.js";
import { projectQueries } from "../api/projects.js";
import { NewChatButton } from "../features/chat/new-chat-button.js";
import { useRuntimeStatus } from "../state/runtime-status.js";

type ImplementedRoute = "/" | "/chats" | "/missions" | "/library" | "/connections" | "/settings";

interface NavItem {
  icon: LucideIcon;
  label: string;
  to?: ImplementedRoute;
  /** Destinations that exist in the product map but are not built yet. They are
   * shown honestly (disabled + "Soon"), never as a fake finished page. */
  upcoming?: boolean;
}

const NAVIGATION: NavItem[] = [
  { icon: Home, label: "Home", to: "/" },
  { icon: MessageSquare, label: "Chats", to: "/chats" },
  { icon: Folder, label: "Projects", upcoming: true },
  { icon: Workflow, label: "Missions", to: "/missions" },
  { icon: Library, label: "Library", to: "/library" },
  { icon: Sparkles, label: "Memory", upcoming: true },
  { icon: Cable, label: "Connections", to: "/connections" },
  { icon: Settings, label: "Settings", to: "/settings" },
];

const runtimeLabels = {
  checking: "Checking runtime",
  offline: "Runtime offline",
  online: "Runtime online",
  reconnecting: "Runtime reconnecting",
} as const;

const runtimeVariants = {
  checking: "neutral",
  offline: "warning",
  online: "success",
  reconnecting: "warning",
} as const;

function getRouteTitle(pathname: string): string {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const routePath = normalizedPath.startsWith("/app")
    ? normalizedPath.slice("/app".length) || "/"
    : normalizedPath;

  if (/^\/missions\/[^/]+$/.test(routePath)) return "Mission workspace";
  if (/^\/chats\/[^/]+$/.test(routePath)) return "Conversation";

  const routeTitles: Record<string, string> = {
    "/": "Home",
    "/chats": "Chats",
    "/connections": "Connections",
    "/library": "Library",
    "/missions": "Missions",
    "/settings": "Settings",
  };
  return routeTitles[routePath] ?? "Morrow";
}

function NavItemLink({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const Icon = item.icon;
  if (item.upcoming || !item.to) {
    return (
      <button
        aria-label={`${item.label} — coming soon`}
        className="morrow-nav__link morrow-nav__link--upcoming"
        data-nav={item.label}
        disabled
        type="button"
      >
        <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
        <span className="morrow-nav__label">{item.label}</span>
        <span className="morrow-nav__soon">Soon</span>
      </button>
    );
  }
  return (
    <Link
      activeOptions={{ exact: item.to === "/" }}
      activeProps={{ "aria-current": "page" }}
      className="morrow-nav__link"
      data-nav={item.label}
      onClick={onNavigate}
      to={item.to}
    >
      <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
      <span className="morrow-nav__label">{item.label}</span>
    </Link>
  );
}

function SidebarNewChat() {
  const projects = useQuery(projectQueries.list());
  return <NewChatButton projectId={projects.data?.[0]?.id} />;
}

function SidebarRecent({ onNavigate }: { onNavigate: () => void }) {
  const projects = useQuery(projectQueries.list());
  const activeProject = projects.data?.[0];
  const conversations = useQuery({
    ...conversationQueries.list(activeProject?.id ?? "", false),
    enabled: Boolean(activeProject),
  });
  const recent = (conversations.data ?? [])
    .filter((conversation) => !conversation.archived)
    .slice(0, 5);

  if (!activeProject || recent.length === 0) return null;

  return (
    <div className="morrow-nav__recent">
      <p className="morrow-nav__section" id="sidebar-recent-heading">
        Recent
      </p>
      <ul aria-labelledby="sidebar-recent-heading" className="morrow-nav__recent-list">
        {recent.map((conversation) => (
          <li key={conversation.id}>
            <Link
              className="morrow-nav__recent-link"
              onClick={onNavigate}
              params={{ conversationId: conversation.id }}
              search={{ projectId: activeProject.id }}
              title={conversation.title}
              to="/chats/$conversationId"
            >
              {conversation.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AppShell() {
  const { status } = useRuntimeStatus();
  const pathname = useRouterState({ select: (routerState) => routerState.location.pathname });
  const mainRef = useRef<HTMLElement>(null);
  const previousPathname = useRef(pathname);
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  useEffect(() => {
    document.title = `${getRouteTitle(pathname)} · Morrow`;
    if (previousPathname.current !== pathname) {
      mainRef.current?.focus();
      setNavOpen(false);
    }
    previousPathname.current = pathname;
  }, [pathname]);

  return (
    <div className="morrow-app-shell" data-nav-open={navOpen ? "true" : undefined}>
      <a className="morrow-skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="morrow-topbar">
        <button
          aria-controls="morrow-sidebar"
          aria-expanded={navOpen}
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          className="morrow-topbar__menu"
          onClick={() => setNavOpen((open) => !open)}
          type="button"
        >
          {navOpen ? <X aria-hidden="true" size={20} /> : <Menu aria-hidden="true" size={20} />}
        </button>
        <span className="morrow-topbar__brand">Morrow</span>
      </header>

      {navOpen ? (
        <button
          aria-hidden="true"
          className="morrow-scrim"
          onClick={closeNav}
          tabIndex={-1}
          type="button"
        />
      ) : null}

      <aside
        className="morrow-sidebar"
        id="morrow-sidebar"
        onKeyDown={(event) => {
          if (event.key === "Escape") setNavOpen(false);
        }}
      >
        <div className="morrow-brand">
          <span aria-hidden="true" className="morrow-brand__mark">
            <Sparkles size={18} strokeWidth={1.8} />
          </span>
          <strong>Morrow</strong>
        </div>

        <div className="morrow-sidebar__new">
          <SidebarNewChat />
        </div>

        <nav aria-label="Primary" className="morrow-nav">
          <div className="morrow-nav__group">
            {NAVIGATION.map((item) => (
              <NavItemLink item={item} key={item.label} onNavigate={closeNav} />
            ))}
          </div>
          <SidebarRecent onNavigate={closeNav} />
        </nav>

        <div className="morrow-sidebar__footer">
          <StatusPill variant={runtimeVariants[status]}>{runtimeLabels[status]}</StatusPill>
          <span className="morrow-profile">Local profile</span>
        </div>
      </aside>

      <main
        className="morrow-main"
        data-error-boundary-focus-target="true"
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
      >
        <Outlet />
      </main>
    </div>
  );
}
