import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { AccountPage } from "../features/account/account-page.js";
import { BillingPage } from "../features/billing/billing-page.js";
import { LoginPage } from "../features/login/login-page.js";
import { SignupPage } from "../features/signup/signup-page.js";
import { AppShell } from "./app-shell.js";

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  component: LoginPage,
  getParentRoute: () => rootRoute,
  path: "/",
});

const loginRoute = createRoute({
  component: LoginPage,
  getParentRoute: () => rootRoute,
  path: "/login",
});

const signupRoute = createRoute({
  component: SignupPage,
  getParentRoute: () => rootRoute,
  path: "/signup",
});

const accountRoute = createRoute({
  component: AccountPage,
  getParentRoute: () => rootRoute,
  path: "/account",
});

const billingRoute = createRoute({
  component: BillingPage,
  getParentRoute: () => rootRoute,
  path: "/billing",
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  accountRoute,
  billingRoute,
]);

export function createDashboardRouter(history: RouterHistory = createBrowserHistory()) {
  return createRouter({
    defaultPreload: "intent",
    history,
    routeTree,
    scrollRestoration: true,
  });
}

export type DashboardRouter = ReturnType<typeof createDashboardRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: DashboardRouter;
  }
}
