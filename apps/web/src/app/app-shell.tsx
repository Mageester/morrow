import { StatusPill } from "@morrow/ui";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  Bot,
  Cable,
  CalendarClock,
  Home,
  Library,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useRuntimeStatus } from "../state/runtime-status.js";

interface NavigationItem {
  icon: LucideIcon;
  label: string;
  /** Marks sections that are visibly incomplete so they never masquerade as finished product areas. */
  preview?: boolean;
  to:
    | "/"
    | "/missions"
    | "/library"
    | "/automations"
    | "/workspace"
    | "/connections"
    | "/settings";
}

const primaryNavigation: NavigationItem[] = [
  { icon: Home, label: "Home", to: "/" },
  { icon: Workflow, label: "Missions", to: "/missions" },
  { icon: Cable, label: "Connections", to: "/connections" },
  { icon: Settings, label: "Settings", to: "/settings" },
];

const secondaryNavigation: NavigationItem[] = [
  { icon: Library, label: "Library", preview: true, to: "/library" },
  { icon: CalendarClock, label: "Automations", preview: true, to: "/automations" },
  { icon: BookOpen, label: "Workspace", preview: true, to: "/workspace" },
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

  if (/^\/missions\/[^/]+$/.test(routePath)) {
    return "Mission workspace";
  }

  const routeTitles: Record<string, string> = {
    "/": "Home",
    "/automations": "Automations",
    "/connections": "Connections",
    "/library": "Library",
    "/missions": "Missions",
    "/settings": "Settings",
    "/workspace": "Workspace",
  };

  return routeTitles[routePath] ?? "Morrow";
}

function NavigationLink({ icon: Icon, label, preview, to }: NavigationItem) {
  return (
    <Link
      activeOptions={{ exact: to === "/" }}
      activeProps={{ "aria-current": "page" }}
      className="morrow-nav__link"
      data-preview={preview ? "true" : undefined}
      to={to}
    >
      <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
      <span>{label}</span>
      {preview ? <span className="morrow-nav__soon">Soon</span> : null}
    </Link>
  );
}

export function AppShell() {
  const { status } = useRuntimeStatus();
  const pathname = useRouterState({
    select: (routerState) => routerState.location.pathname,
  });
  const mainRef = useRef<HTMLElement>(null);
  const previousPathname = useRef(pathname);

  useEffect(() => {
    document.title = `${getRouteTitle(pathname)} · Morrow`;

    if (previousPathname.current !== pathname) {
      mainRef.current?.focus();
    }
    previousPathname.current = pathname;
  }, [pathname]);

  return (
    <div className="morrow-app-shell">
      <a className="morrow-skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="morrow-sidebar">
        <div className="morrow-brand">
          <span aria-hidden="true" className="morrow-brand__mark">
            <Bot size={18} strokeWidth={1.8} />
          </span>
          <div>
            <strong>Morrow</strong>
            <span>Personal workspace</span>
          </div>
        </div>

        <nav aria-label="Primary" className="morrow-nav">
          <div className="morrow-nav__group">
            {primaryNavigation.map((item) => (
              <NavigationLink key={item.to} {...item} />
            ))}
          </div>
          <div className="morrow-nav__group morrow-nav__group--secondary">
            {secondaryNavigation.map((item) => (
              <NavigationLink key={item.to} {...item} />
            ))}
          </div>
        </nav>

        <div className="morrow-sidebar__footer">
          <StatusPill variant={runtimeVariants[status]}>
            {runtimeLabels[status]}
          </StatusPill>
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
