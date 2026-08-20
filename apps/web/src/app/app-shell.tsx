import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Brain,
  Cable,
  Clock3,
  Folder,
  Home,
  MoreHorizontal,
  Settings,
  Sparkles,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AmbientMark } from "../components/product-frame.js";
import { NewChatButton } from "../features/chat/new-chat-button.js";
import { OnboardingExperience } from "../features/onboarding/onboarding-experience.js";
import { PairingBanner } from "../features/pairing/pairing-banner.js";
import { useActiveProject } from "../features/projects/use-active-project.js";
import { RosterRail } from "../features/roster/roster-rail.js";
import { useRuntimeStatus } from "../state/runtime-status.js";
import { ShellTitleProvider } from "./shell-title.js";
import { ShellTopbar } from "./shell-topbar.js";

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
  if (!activeProject) {
    return (
      <Link className="morrow-sidebar-project-action" to="/projects">
        <Folder aria-hidden="true" size={16} strokeWidth={1.8} />
        <span>Choose a project</span>
      </Link>
    );
  }
  return <NewChatButton projectId={activeProject?.id} />;
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
    <ShellTitleProvider>
    <div className="morrow-app-shell" data-nav-open={navOpen ? "true" : undefined}>
      <a className="morrow-skip-link" href="#main-content">
        Skip to content
      </a>

      <OnboardingExperience pathname={pathname} />

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
        </div>

        <nav aria-label="Primary" className="morrow-nav">
          <div className="morrow-nav__group">
            {NAVIGATION.map((item) => (
              <NavItemLink item={item} key={item.label} onNavigate={closeNav} />
            ))}
          </div>
        </nav>

        {/* A sibling of the navigation, not a child of it: a roster of
            teammates is people and their work, not a set of destinations, and
            a screen reader should not have to walk it to reach Settings. */}
        <RosterRail onNavigate={closeNav} />

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
        <ShellTopbar
          navOpen={navOpen}
          onToggleNav={() => setNavOpen((open) => !open)}
          routeTitle={getRouteTitle(pathname)}
        />
        <div className="morrow-route-canvas" key={pathname}>
          <PairingBanner />
          <Outlet />
        </div>
      </main>
      <MobileDock onMore={() => setNavOpen(true)} onNavigate={closeNav} />
    </div>
    </ShellTitleProvider>
  );
}
