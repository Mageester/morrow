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
import { ConnectionsPage } from "../features/connections/connections-page.js";
import { ProjectsPage } from "../features/projects/projects-page.js";
import { ChatsPage } from "../features/chat/chats-page.js";
import { ConversationPage } from "../features/chat/conversation-page.js";
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

const chatsRoute = createRoute({
  component: ChatsPage,
  getParentRoute: () => rootRoute,
  path: "/chats",
});

const projectsRoute = createRoute({
  component: ProjectsPage,
  getParentRoute: () => rootRoute,
  path: "/projects",
});

const conversationRoute = createRoute({
  component: ConversationPage,
  getParentRoute: () => rootRoute,
  path: "/chats/$conversationId",
  validateSearch: (search: Record<string, unknown>) => ({
    projectId: typeof search.projectId === "string" ? search.projectId : undefined,
  }),
});

const libraryRoute = createRoute({
  component: LibraryPage,
  getParentRoute: () => rootRoute,
  path: "/library",
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
  chatsRoute,
  projectsRoute,
  missionsRoute,
  missionRoute,
  conversationRoute,
  libraryRoute,
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
