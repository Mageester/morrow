import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { LibraryPage } from "../features/library/library-page.js";
import { HomePage } from "../features/home/home-page.js";
import { MissionPage } from "../features/missions/mission-page.js";
import { MissionsPage } from "../features/missions/missions-page.js";
import { ComingSoonPage } from "../features/placeholders/coming-soon-page.js";
import { ConnectionsPage } from "../features/placeholders/connections-page.js";
import { SettingsPage } from "../features/placeholders/settings-page.js";
import { AppShell } from "./app-shell.js";

const rootRoute = createRootRoute({ component: AppShell });

const homeRoute = createRoute({
  component: HomePage,
  getParentRoute: () => rootRoute,
  path: "/",
});

const missionsRoute = createRoute({
  component: MissionsPage,
  getParentRoute: () => rootRoute,
  path: "/missions",
});

const missionRoute = createRoute({
  component: MissionPage,
  getParentRoute: () => rootRoute,
  path: "/missions/$missionId",
});

const libraryRoute = createRoute({
  component: LibraryPage,
  getParentRoute: () => rootRoute,
  path: "/library",
});

const automationsRoute = createRoute({
  component: () => (
    <ComingSoonPage
      description="Create schedules and triggers for work that should run later."
      title="Automations"
    />
  ),
  getParentRoute: () => rootRoute,
  path: "/automations",
});

const workspaceRoute = createRoute({
  component: () => (
    <ComingSoonPage
      description="Manage the local context Morrow uses for your work."
      title="Workspace"
    />
  ),
  getParentRoute: () => rootRoute,
  path: "/workspace",
});

const connectionsRoute = createRoute({
  component: ConnectionsPage,
  getParentRoute: () => rootRoute,
  path: "/connections",
});

const settingsRoute = createRoute({
  component: SettingsPage,
  getParentRoute: () => rootRoute,
  path: "/settings",
});

export const routeTree = rootRoute.addChildren([
  homeRoute,
  missionsRoute,
  missionRoute,
  libraryRoute,
  automationsRoute,
  workspaceRoute,
  connectionsRoute,
  settingsRoute,
]);

export function createAppRouter(history: RouterHistory = createBrowserHistory()) {
  return createRouter({
    basepath: "/app",
    defaultPreload: "intent",
    history,
    routeTree,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
