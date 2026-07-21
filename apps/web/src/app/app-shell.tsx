import { StatusPill } from "@morrow/ui";
import { Link, Outlet } from "@tanstack/react-router";
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
import { useRuntimeStatus } from "../state/runtime-status.js";

interface NavigationItem {
  icon: LucideIcon;
  label: string;
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
  { icon: Library, label: "Library", to: "/library" },
  { icon: CalendarClock, label: "Automations", to: "/automations" },
];

const secondaryNavigation: NavigationItem[] = [
  { icon: BookOpen, label: "Workspace", to: "/workspace" },
  { icon: Cable, label: "Connections", to: "/connections" },
  { icon: Settings, label: "Settings", to: "/settings" },
];

const runtimeLabels = {
  checking: "Checking runtime",
  offline: "Runtime offline",
  online: "Runtime online",
} as const;

const runtimeVariants = {
  checking: "neutral",
  offline: "warning",
  online: "success",
} as const;

function NavigationLink({ icon: Icon, label, to }: NavigationItem) {
  return (
    <Link
      activeOptions={{ exact: to === "/" }}
      activeProps={{ "aria-current": "page" }}
      className="morrow-nav__link"
      to={to}
    >
      <Icon aria-hidden="true" size={19} strokeWidth={1.8} />
      <span>{label}</span>
    </Link>
  );
}

export function AppShell() {
  const { status } = useRuntimeStatus();

  return (
    <div className="morrow-app-shell">
      <a className="morrow-skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="morrow-sidebar">
        <div className="morrow-brand">
          <span aria-hidden="true" className="morrow-brand__mark">
            <Bot size={22} strokeWidth={1.8} />
          </span>
          <div>
            <strong>Morrow</strong>
            <span>Private intelligence</span>
          </div>
        </div>

        <div className="morrow-workspace-switcher">
          <span>Personal workspace</span>
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

      <main className="morrow-main" id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
