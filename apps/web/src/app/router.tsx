import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from "@tanstack/react-router";
import { NotFoundPage } from "../features/placeholders/not-found-page.js";
import { AppShell } from "./app-shell.js";

// Route-level loading keeps the initial command surface small. Dense mission,
// provider, and conversation surfaces only enter the bundle when the user
// actually visits them, which matters on the local mobile handoff as well as
// the desktop app.
const HomePage = lazyRouteComponent(() => import("../features/home/home-page.js"), "HomePage");
const MissionPage = lazyRouteComponent(() => import("../features/missions/mission-page.js"), "MissionPage");
const MissionsPage = lazyRouteComponent(() => import("../features/missions/missions-page.js"), "MissionsPage");
const ConnectionsPage = lazyRouteComponent(() => import("../features/connections/connections-page.js"), "ConnectionsPage");
const ProjectsPage = lazyRouteComponent(() => import("../features/projects/projects-page.js"), "ProjectsPage");
const ChatsPage = lazyRouteComponent(() => import("../features/chat/chats-page.js"), "ChatsPage");
const ConversationPage = lazyRouteComponent(() => import("../features/chat/conversation-page.js"), "ConversationPage");
const LibraryPage = lazyRouteComponent(() => import("../features/library/library-page.js"), "LibraryPage");
const PairPage = lazyRouteComponent(() => import("../features/pairing/pair-page.js"), "PairPage");
const SettingsPage = lazyRouteComponent(() => import("../features/placeholders/settings-page.js"), "SettingsPage");
const MemoryPage = lazyRouteComponent(() => import("../features/memory/memory-page.js"), "MemoryPage");
const TeamsPage = lazyRouteComponent(() => import("../features/teams/teams-page.js"), "TeamsPage");

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

const pairRoute = createRoute({
  component: PairPage,
  getParentRoute: () => rootRoute,
  path: "/pair",
});

const memoryRoute = createRoute({
  component: MemoryPage,
  getParentRoute: () => rootRoute,
  path: "/memory",
});

const teamsRoute = createRoute({
  component: TeamsPage,
  getParentRoute: () => rootRoute,
  path: "/teams",
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
  pairRoute,
  memoryRoute,
  teamsRoute,
]);

export function createAppRouter(history: RouterHistory = createBrowserHistory()) {
  return createRouter({
    basepath: "/app",
    // Without this an unrecognised address rendered the shell around an empty
    // content region — no heading, no explanation, no way back.
    defaultNotFoundComponent: NotFoundPage,
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
