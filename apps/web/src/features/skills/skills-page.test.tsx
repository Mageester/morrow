import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveProjectProvider } from "../../state/active-project.js";
import { SkillsPage } from "./skills-page.js";

const now = "2026-08-12T12:00:00.000Z";
const project = { id: "project-1", name: "Morrow", version: 1, workspacePath: "C:\\morrow", createdAt: now };
const learned = {
  id: "validate-pnpm", projectId: project.id, version: "2.0.0", triggerConditions: ["pnpm check", "repository validation"],
  scope: "repository", steps: ["Run `pnpm check` from the repository root.", "Require exit code 0."],
  permissions: { tools: ["command-exec"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] },
  validationRequirements: ["two_distinct_successful_missions"],
  provenance: [
    { missionId: "m1", learningId: "l1", evidenceReferences: [{ kind: "command", reference: "pnpm check" }], observedAt: now },
    { missionId: "m2", learningId: "l2", evidenceReferences: [{ kind: "command", reference: "pnpm check" }], observedAt: now },
  ],
  state: "active", successCount: 2, failureCount: 0, confidence: 0.9, lastVerifiedAt: now,
  rollbackHistory: [], workflowFingerprint: "0123456789abcdef", directory: "C:\\skills\\validate-pnpm", createdAt: now, updatedAt: now,
};

function renderPage() {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/", component: SkillsPage });
  const router = createRouter({ history: createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([route]) });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ActiveProjectProvider><RouterProvider router={router as AnyRouter} /></ActiveProjectProvider></QueryClientProvider>);
}

describe("Skills page", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows learned procedures and reveals their evidence and steps", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url === "/api/skills") return Response.json([]);
      if (url.endsWith("/skills/learned")) return Response.json([learned]);
      if (url.endsWith("/skills/usage")) return Response.json([{ version: 1, projectId: project.id, skillId: learned.id, count: 3, lastUsedAt: now }]);
      return Response.json([]);
    }));
    const user = userEvent.setup();
    renderPage();

    const workflow = await screen.findByText("Validate with pnpm check");
    expect(screen.getByText("2 verified uses")).toBeVisible();
    await user.click(workflow);
    expect(await screen.findByText("Run `pnpm check` from the repository root.")).toBeVisible();
    expect(screen.getByText("2 verified tasks")).toBeVisible();
    expect(screen.getAllByText("None")).toHaveLength(2);
  });

  it("teaches through the empty state and filters skills without a card grid", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url === "/api/skills") return Response.json([]);
      return Response.json([]);
    }));
    renderPage();
    expect(await screen.findByRole("heading", { name: "No skills yet" })).toBeVisible();
    expect(screen.getByText(/learns reusable workflows/i)).toBeVisible();
  });
});
