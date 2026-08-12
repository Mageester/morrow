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
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingExperience } from "./onboarding-experience.js";

const profile = {
  version: 1,
  id: "default",
  displayName: null,
  assistantName: null,
  commsVerbosity: "concise",
  commsTone: "nontechnical",
  timezone: null,
  locale: null,
  defaultProviderId: null,
  defaultModel: null,
  defaultReasoning: { mode: "auto" },
  defaultPrivacyMode: "local_only",
  defaultApprovalPosture: "ask_always",
  goals: [],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

function provider(configured: boolean) {
  return {
    version: 1,
    id: "openrouter",
    label: "OpenRouter",
    kind: "api-key",
    configured,
    available: configured,
    endpointType: "default",
    endpointHost: "openrouter.ai",
    authStatus: configured ? "configured" : "missing",
    authMode: "openrouter-api-key",
    capabilities: {
      streaming: true,
      toolCalls: true,
      systemMessages: true,
      vision: true,
      customEndpoint: false,
      local: false,
    },
    models: [],
    defaultModel: null,
    note: null,
    setupHint: "Add an API key to connect OpenRouter.",
  };
}

interface RenderOptions {
  onboarding?: {
    onboarded: boolean;
    onboardingStep: string | null;
    useCase: string | null;
    name: string | null;
  };
  providers?: unknown[];
  projects?: unknown[];
  pathname?: string;
}

function renderExperience(options: RenderOptions = {}) {
  let onboarding = options.onboarding ?? {
    onboarded: false,
    onboardingStep: null,
    useCase: null,
    name: null,
  };
  const onboardingUpdates: Array<Record<string, unknown>> = [];
  const profileUpdates: Array<Record<string, unknown>> = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/onboarding" && (!init?.method || init.method === "GET")) {
        return Response.json(onboarding);
      }
      if (url === "/api/onboarding" && init?.method === "POST") {
        const update = JSON.parse(String(init.body)) as Record<string, unknown>;
        onboardingUpdates.push(update);
        onboarding = { ...onboarding, ...update };
        return Response.json({ success: true });
      }
      if (url === "/api/assistant-profile" && init?.method === "PATCH") {
        const update = JSON.parse(String(init.body)) as Record<string, unknown>;
        profileUpdates.push(update);
        return Response.json({ ...profile, ...update });
      }
      if (url === "/api/providers") return Response.json(options.providers ?? []);
      if (url === "/api/projects") return Response.json(options.projects ?? []);
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    }),
  );

  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <OnboardingExperience pathname={options.pathname ?? "/"} />,
  });
  const connections = createRoute({ getParentRoute: () => root, path: "/connections", component: () => null });
  const projects = createRoute({ getParentRoute: () => root, path: "/projects", component: () => null });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [options.pathname ?? "/"] }),
    routeTree: root.addChildren([home, connections, projects]),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as unknown as AnyRouter} />
    </QueryClientProvider>,
  );

  return { ...view, onboardingUpdates, profileUpdates };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("OnboardingExperience", () => {
  it("opens a fresh install on the welcome scene and lets the user explore without a setup lockout", async () => {
    const { onboardingUpdates } = renderExperience();
    expect(await screen.findByRole("heading", { name: "Your private intelligence, ready to grow with you." })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Welcome to Morrow" })).toBeVisible();

    await userEvent.setup().click(screen.getByRole("button", { name: "Explore first" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onboardingUpdates).toContainEqual({ onboarded: true, onboardingStep: null });
  });

  it("resumes the persisted scene instead of replaying the welcome screen", async () => {
    renderExperience({
      onboarding: { onboarded: false, onboardingStep: "privacy", useCase: null, name: null },
    });

    expect(await screen.findByRole("heading", { name: "Private by design." })).toBeVisible();
    expect(screen.queryByText("Your private intelligence, ready to grow with you.")).not.toBeInTheDocument();
    expect(screen.getByText("2 of 5")).toBeVisible();
  });

  it("persists personalization and presents real provider and project readiness", async () => {
    const { onboardingUpdates, profileUpdates } = renderExperience();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Begin" }));
    await user.click(screen.getByRole("radio", { name: /Controlled cloud/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByRole("textbox", { name: "What should Morrow call you?" }), "Aidan");
    await user.click(screen.getByRole("radio", { name: "Research & thinking" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Connect the essentials." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Connect a model" })).toHaveAttribute("href", "/connections");
    expect(screen.getByRole("link", { name: "Add a project" })).toHaveAttribute("href", "/projects");
    expect(profileUpdates).toContainEqual({ defaultPrivacyMode: "controlled_cloud" });
    expect(profileUpdates).toContainEqual({ displayName: "Aidan" });
    expect(onboardingUpdates).toContainEqual({ name: "Aidan", onboardingStep: "readiness", useCase: "research" });
  });

  it("finishes honestly when setup is already ready", async () => {
    const project = { id: "p1", name: "Morrow", version: 1, workspacePath: "C:\\morrow", createdAt: "2026-08-12T00:00:00.000Z" };
    const { onboardingUpdates } = renderExperience({
      onboarding: { onboarded: false, onboardingStep: "readiness", useCase: "building", name: "Aidan" },
      providers: [provider(true)],
      projects: [project],
    });
    const user = userEvent.setup();

    expect(await screen.findByText("Model connected")).toBeVisible();
    expect(screen.getByText("Project ready")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Morrow is yours." })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Morrow" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onboardingUpdates).toContainEqual({ onboarded: true, onboardingStep: null });
  });

  it("never covers non-home setup routes or an onboarded install", async () => {
    const configured = renderExperience({
      onboarding: { onboarded: true, onboardingStep: null, useCase: "building", name: "Aidan" },
    });
    await waitFor(() => expect(configured.container.querySelector(".morrow-onboarding")).toBeNull());
    configured.unmount();

    const setupRoute = renderExperience({ pathname: "/connections" });
    await waitFor(() => expect(setupRoute.container.querySelector(".morrow-onboarding")).toBeNull());
  });
});
