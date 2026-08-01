import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairingBanner } from "./pairing-banner.js";

function renderBanner(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const homeRoute = createRoute({ getParentRoute: () => root, path: "/", component: PairingBanner });
  const pairRoute = createRoute({ getParentRoute: () => root, path: "/pair", component: () => null });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([homeRoute, pairRoute]),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as AnyRouter} />
    </QueryClientProvider>,
  );
  return { queryClient };
}

function statusResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return Response.json({
    version: 1,
    status: "unpaired",
    accountId: null,
    planId: null,
    checkedAt: null,
    lastError: null,
    ...overrides,
  });
}

describe("PairingBanner", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a soft hint with a link to /pair when unpaired", async () => {
    renderBanner(async () => statusResponse({ status: "unpaired" }));
    expect(await screen.findByText(/not connected to an account/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /pair this install/i })).toBeVisible();
  });

  it("shows a non-blocking warning when the subscription is inactive", async () => {
    renderBanner(async () => statusResponse({ status: "inactive", accountId: "acct-1", planId: "free" }));
    expect(await screen.findByText(/subscription inactive/i)).toBeVisible();
    expect(screen.getByText(/local work is unaffected/i)).toBeVisible();
  });

  it("renders nothing when active", async () => {
    const { queryClient } = renderBanner(async () =>
      statusResponse({ status: "active", accountId: "acct-1", planId: "free" }),
    );
    await waitFor(() => expect(queryClient.getQueryState(["pairing", "status"])?.status).toBe("success"));
    expect(screen.queryByText(/not connected to an account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/subscription inactive/i)).not.toBeInTheDocument();
  });

  it("renders nothing when the entitlement check is unresolvable (network blip)", async () => {
    const { queryClient } = renderBanner(async () =>
      statusResponse({ status: "unknown", accountId: "acct-1", lastError: "hosted-api unreachable" }),
    );
    await waitFor(() => expect(queryClient.getQueryState(["pairing", "status"])?.status).toBe("success"));
    expect(screen.queryByText(/not connected to an account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/subscription inactive/i)).not.toBeInTheDocument();
  });
});
