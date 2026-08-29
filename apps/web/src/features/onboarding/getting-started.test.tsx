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
import { ActiveProjectProvider } from "../../state/active-project.js";
import { GettingStarted } from "./getting-started.js";

// Must satisfy ProviderStatusSchema in full: a short fixture fails validation,
// which leaves the query un-successful and the component rendering nothing —
// so a test asserting the card is absent would pass for entirely the wrong
// reason.
function provider(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, id: "openrouter", label: "OpenRouter", kind: "api-key", configured: false,
    available: false, endpointType: "default", endpointHost: "openrouter.ai", authStatus: "missing",
    authMode: "openrouter-api-key",
    capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: true, customEndpoint: false, local: false },
    models: [], defaultModel: null, note: null, setupHint: "Add an API key to connect OpenRouter.",
    ...overrides,
  };
}

const project = { id: "p1", name: "App", version: 1, workspacePath: "C:\\app", createdAt: "2026-07-29T00:00:00.000Z" };

function renderChecklist(options: {
  providers?: unknown[];
  projects?: unknown[];
  pairing?: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/providers") return Response.json(options.providers ?? []);
      if (url === "/api/projects") return Response.json(options.projects ?? []);
      if (url === "/api/pairing/status") {
        return Response.json({
          version: 1, status: options.pairing ?? "unpaired",
          accountId: null, planId: null, checkedAt: null, lastError: null,
        });
      }
      if (url === "/api/assistant-profile") {
        return Response.json({
          version: 1, id: "default", displayName: null, assistantName: null, commsVerbosity: "concise",
          commsTone: "nontechnical", timezone: null, locale: null, defaultProviderId: null, defaultModel: null,
          defaultReasoning: { mode: "auto" }, defaultPrivacyMode: "local_only", defaultApprovalPosture: "ask_always",
          goals: [], createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z",
        });
      }
      if (url.includes("/teams")) return Response.json([]);
      throw new Error(`unexpected ${url}`);
    }),
  );
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/", component: GettingStarted });
  const stubs = ["/connections", "/projects", "/pair", "/settings", "/teams"].map((path) =>
    createRoute({ getParentRoute: () => root, path, component: () => null }),
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([home, ...stubs]),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ActiveProjectProvider>
        <RouterProvider router={router as unknown as AnyRouter} />
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GettingStarted", () => {
  it("names both first-run steps on an empty install", async () => {
    renderChecklist({});
    expect(await screen.findByRole("link", { name: "Connect a model" })).toBeVisible();
    expect(await screen.findByRole("link", { name: "Add a project" })).toBeVisible();
  });

  /**
   * The case the old no-project empty state could never reach: a project
   * exists, so no empty state renders, but nothing is connected — which sent
   * the user straight to a composer where every send failed.
   */
  it("still asks for a model when a project already exists", async () => {
    renderChecklist({ projects: [project] });
    expect(await screen.findByRole("link", { name: "Connect a model" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Add a project" })).not.toBeInTheDocument();
  });

  it("retires itself once the required steps are done", async () => {
    const { container } = renderChecklist({
      providers: [provider({ configured: true })],
      projects: [project],
    });
    await waitFor(() => expect(container.querySelector(".morrow-getting-started")).toBeNull());
  });

  it("does not count the internal mock provider as a connected model", async () => {
    renderChecklist({ providers: [provider({ id: "mock", label: "Mock", configured: true })] });
    expect(await screen.findByRole("link", { name: "Connect a model" })).toBeVisible();
  });

  it("treats the account link as optional and never blocks on it", async () => {
    const { container } = renderChecklist({
      providers: [provider({ configured: true })],
      projects: [project],
      pairing: "unpaired",
    });
    await waitFor(() => expect(container.querySelector(".morrow-getting-started")).toBeNull());
  });

  it("names the privacy-mode and team steps, both optional and never blocking retirement", async () => {
    renderChecklist({});
    // Privacy mode is already satisfied by its safe default (local_only) —
    // it shows as Done, not an action to complete. What it must not do is call
    // itself advisory: local-only is a hard gate the service enforces, and
    // saying otherwise sent people hunting for a bug when Morrow declined a
    // request it was configured to decline.
    expect(await screen.findByText("Review your privacy preference")).toBeVisible();
    expect(screen.getByText(/refuses every provider that runs off this machine/i)).toBeVisible();
    expect(screen.queryByText(/does not enforce provider routing/i)).toBeNull();
    // Team creation genuinely needs action, so it shows a real link.
    expect(await screen.findByRole("link", { name: "Create a team" })).toBeVisible();
    // Both optional steps carry the "Optional" badge, distinguishing them from
    // the two required steps.
    const optionalBadges = screen.getAllByText("Optional");
    expect(optionalBadges.length).toBeGreaterThanOrEqual(2);
  });
});
