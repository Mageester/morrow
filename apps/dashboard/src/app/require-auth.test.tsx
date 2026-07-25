import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "./require-auth.js";

const useAuth = vi.fn();
vi.mock("@clerk/react", () => ({
  useAuth: () => useAuth(),
}));

function renderProtected() {
  const root = createRootRoute();
  const protectedRoute = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <RequireAuth>
        <div>secret content</div>
      </RequireAuth>
    ),
  });
  const loginRoute = createRoute({ getParentRoute: () => root, path: "/login", component: () => <div>login page</div> });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([protectedRoute, loginRoute]),
  });
  render(<RouterProvider router={router as AnyRouter} />);
}

describe("RequireAuth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders nothing while the session is still loading", () => {
    useAuth.mockReturnValue({ isLoaded: false, isSignedIn: false });
    renderProtected();
    expect(screen.queryByText("secret content")).not.toBeInTheDocument();
    expect(screen.queryByText("login page")).not.toBeInTheDocument();
  });

  it("redirects to /login when loaded and signed out", async () => {
    useAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    renderProtected();
    expect(await screen.findByText("login page")).toBeVisible();
  });

  it("renders the protected content when signed in", async () => {
    useAuth.mockReturnValue({ isLoaded: true, isSignedIn: true });
    renderProtected();
    expect(await screen.findByText("secret content")).toBeVisible();
  });
});
