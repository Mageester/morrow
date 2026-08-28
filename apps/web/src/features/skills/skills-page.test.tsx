import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
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

const catalogEntry = {
  key: "bundled:writing", id: "writing", name: "Writing", description: "Draft prose.", source: "bundled",
  enabled: true, validation: "healthy", issues: [], loadable: true, manifestDigest: "a".repeat(64),
  category: "writing", trustTier: "trusted", tools: [], permissions: [], dependencies: [], publisher: "morrow",
};
const disabledEntry = { ...catalogEntry, key: "user:calendar", id: "calendar", name: "Calendar", description: "Manage calendars.", source: "user", enabled: false, loadable: false };
const invalidEntry = {
  ...catalogEntry, key: "user:broken", id: "broken", name: "Broken", description: "Bad manifest.", source: "user",
  enabled: false, loadable: false, validation: "invalid", manifestDigest: null,
  issues: [{ code: "invalid_manifest", message: "manifest.json could not be parsed" }],
};
const conflictEntry = {
  ...catalogEntry, key: "workspace:project-1:writing", id: "writing", name: "Writing", source: "workspace",
  enabled: false, loadable: false, validation: "conflict",
  issues: [{ code: "id_conflict", message: 'Two skills declare the id "writing"' }],
};

const emptyStatus = { healthy: true, entries: 0, loadable: 0, issues: [] };

function stubSkills(entries: unknown[], status: unknown = { ...emptyStatus, entries: entries.length }) {
  const patched: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      patched.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ ...disabledEntry, enabled: true, loadable: true });
    }
    if (url === "/api/projects") return Response.json([project]);
    if (url.startsWith("/api/skills/status")) return Response.json(status);
    if (url.startsWith("/api/skills")) return Response.json(entries);
    return Response.json([]);
  }));
  return patched;
}

describe("Skills page", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * The row and dossier report the service's verdict. A skill that Morrow
   * cannot load must never read as one that is ready to use.
   */
  it("shows the catalog's own state for every kind of entry", async () => {
    stubSkills([catalogEntry, disabledEntry, invalidEntry, conflictEntry]);
    renderPage();

    const rows = await screen.findAllByRole("button", { name: /Writing|Calendar|Broken/ });
    const labels = rows.map((row) => row.textContent ?? "");
    expect(labels.some((label) => label.endsWith("Enabled"))).toBe(true);
    expect(labels.some((label) => label.endsWith("Disabled"))).toBe(true);
    expect(labels.some((label) => label.endsWith("Needs attention"))).toBe(true);
    expect(labels.some((label) => label.endsWith("Conflict"))).toBe(true);
  });

  it("refuses to offer a switch for a skill it could not load", async () => {
    stubSkills([invalidEntry]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /Broken/ }));
    expect(screen.getByText("manifest.json could not be parsed")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Enable$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Disable$/ })).toBeNull();
  });

  it("enables through the service and re-reads the result", async () => {
    const patched = stubSkills([disabledEntry]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /^Enable$/ }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]?.url).toContain("/api/skills/user%3Acalendar");
    expect(patched[0]?.body).toEqual({ enabled: true });
  });

  /** An unreadable root is a fault; it must not look like a fresh install. */
  it("reports a root failure instead of an empty cabinet", async () => {
    stubSkills([], { healthy: false, entries: 0, loadable: 0, issues: [{ code: "root_unavailable", message: "The user skill root could not be read" }] });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Skills could not be read" })).toBeVisible();
    expect(screen.getByText("The user skill root could not be read")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "No skills yet" })).toBeNull();
  });

  it("shows learned procedures and reveals their evidence and steps", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url.startsWith("/api/skills")) return Response.json(url.startsWith("/api/skills/status") ? emptyStatus : []);
      if (url.endsWith("/skills/learned")) return Response.json([learned]);
      if (url.endsWith("/skills/usage")) return Response.json([{ version: 1, projectId: project.id, skillId: learned.id, count: 3, lastUsedAt: now }]);
      return Response.json([]);
    }));
    const user = userEvent.setup();
    renderPage();

    const workflow = await screen.findByRole("button", { name: /Validate with pnpm check/ });
    expect(screen.getByText("verified uses").closest("div")).toHaveTextContent("2verified uses");
    await user.click(workflow);
    expect(await screen.findByText("Run `pnpm check` from the repository root.")).toBeVisible();
    expect(screen.getByText("2 verified tasks")).toBeVisible();
    expect(screen.getAllByText("None")).toHaveLength(2);
  });

  it("teaches through the empty state and filters skills without a card grid", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url.startsWith("/api/skills")) return Response.json(url.startsWith("/api/skills/status") ? emptyStatus : []);
      return Response.json([]);
    }));
    renderPage();
    expect(await screen.findByRole("heading", { name: "No skills yet" })).toBeVisible();
    expect(screen.getByText(/learns reusable workflows/i)).toBeVisible();
  });
});
