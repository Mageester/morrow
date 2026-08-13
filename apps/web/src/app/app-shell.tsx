import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Brain,
  Cable,
  Clock3,
  Folder,
  Home,
  Menu,
  MoreHorizontal,
  Settings,
  Sparkles,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { conversationQueries } from "../api/conversations.js";
import { AmbientMark } from "../components/product-frame.js";
import { NewChatButton } from "../features/chat/new-chat-button.js";
import { OnboardingExperience } from "../features/onboarding/onboarding-experience.js";
import { PairingBanner } from "../features/pairing/pairing-banner.js";
import { useActiveProject } from "../features/projects/use-active-project.js";
import { CommandPalette } from "../features/search/command-palette.js";
import { useRuntimeStatus } from "../state/runtime-status.js";

type ImplementedRoute =
  | "/"
  | "/chats"
  | "/missions"
  | "/connections"
  | "/settings"
  | "/projects"
  | "/pair"
  | "/memory"
  | "/skills"
  | "/teams";

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
  { icon: Folder, label: "Projects", to: "/projects" },
  { icon: WandSparkles, label: "Skills", to: "/skills" },
  { icon: Brain, label: "Memory", to: "/memory" },
  { icon: Clock3, label: "History", to: "/chats" },
  { icon: Cable, label: "Connections", to: "/connections" },
  { icon: Settings, label: "Settings", to: "/settings" },
];

const MOBILE_NAVIGATION: NavItem[] = [
  { icon: Home, label: "Home", to: "/" },
  { icon: Clock3, label: "History", to: "/chats" },
  { icon: Folder, label: "Projects", to: "/projects" },
  { icon: WandSparkles, label: "Skills", to: "/skills" },
];

const runtimeLabels = {
  checking: "Checking runtime",
  offline: "Runtime offline",
  online: "Runtime online",
  reconnecting: "Runtime reconnecting",
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
    "/chats": "History",
    "/connections": "Connections",
    "/memory": "Memory",
    "/missions": "Missions",
    "/pair": "Pair this install",
    "/projects": "Projects",
    "/settings": "Settings",
    "/skills": "Skills",
    "/teams": "Teams",
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
  const { activeProject } = useActiveProject();
  return <NewChatButton projectId={activeProject?.id} />;
}

function SidebarRecent({ onNavigate }: { onNavigate: () => void }) {
  const { activeProject } = useActiveProject();
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

function WorkspaceContext() {
  const { activeProject, isPending } = useActiveProject();
  const workspaceName = isPending ? "Checking workspace" : activeProject?.name ?? "No project selected";

  return (
    <Link
      aria-label={`Current workspace: ${workspaceName}`}
      className="morrow-shell-workspace"
      data-state={isPending ? "loading" : activeProject ? "ready" : "empty"}
      to="/projects"
    >
      <span aria-hidden="true" className="morrow-shell-workspace__signal" />
      <span className="morrow-shell-workspace__copy">
        <span>Workspace</span>
        <strong>{workspaceName}</strong>
      </span>
      <span aria-hidden="true" className="morrow-shell-workspace__arrow">↗</span>
    </Link>
  );
}

function MobileDock({ onMore, onNavigate }: { onMore: () => void; onNavigate: () => void }) {
  return (
    <nav aria-label="Mobile navigation" className="morrow-mobile-dock">
      {MOBILE_NAVIGATION.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            activeOptions={{ exact: item.to === "/" }}
            activeProps={{ "aria-current": "page" }}
            className="morrow-mobile-dock__link"
            data-nav={item.label}
            key={item.label}
            onClick={onNavigate}
            to={item.to!}
          >
            <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
            <span>{item.label}</span>
          </Link>
        );
      })}
      <button aria-label="More navigation" className="morrow-mobile-dock__link" onClick={onMore} type="button">
        <MoreHorizontal aria-hidden="true" size={19} strokeWidth={1.8} />
        <span>More</span>
      </button>
    </nav>
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

      <OnboardingExperience pathname={pathname} />

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
        <span aria-hidden="true" className="morrow-topbar__brand-mark"><Sparkles size={15} strokeWidth={1.8} /></span>
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
        <AmbientMark variant="arc" />
        <div className="morrow-brand">
          <span aria-hidden="true" className="morrow-brand__mark">
            <Sparkles size={18} strokeWidth={1.8} />
          </span>
          <strong>Morrow</strong>
        </div>

        <div className="morrow-sidebar__new">
          <SidebarNewChat />
          <CommandPalette />
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
          <div
            aria-label={`Morrow runtime: ${runtimeLabels[status]}`}
            className="morrow-shell-runtime"
            role="status"
          >
            <span aria-hidden="true" className="morrow-shell-runtime__signal" data-state={status} />
            <span>
              <strong>Local Morrow</strong>
              <small>{runtimeLabels[status]}</small>
            </span>
          </div>
        </div>
      </aside>

      <main
        className="morrow-main"
        data-error-boundary-focus-target="true"
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
      >
        <div className="morrow-shell-context">
          <WorkspaceContext />
          <PairingBanner />
        </div>
        <div className="morrow-route-canvas" key={pathname}>
          <Outlet />
        </div>
      </main>
      <MobileDock onMore={() => setNavOpen(true)} onNavigate={closeNav} />
    </div>
  );
}
