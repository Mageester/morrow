import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveProjectProvider } from "../../state/active-project.js";
import { MemoryPage } from "./memory-page.js";

const now = "2026-08-11T12:00:00.000Z";
const project = { id: "project-1", name: "Local project", version: 1, workspacePath: "C:\\local", createdAt: now };
const entry = {
  version: 1, id: "mem-1", projectId: project.id, conversationId: null, scope: "project", type: "project_architecture",
  content: "Uses pnpm workspaces.", normalizedContent: "uses pnpm workspaces.", source: "user", evidenceReferences: [],
  lifecycle: "active", originTaskId: null, pinned: false, enabled: true, lastVerifiedAt: null, confidence: 1,
  usageCount: 2, successContribution: 0, failureContribution: 0, staleness: "current", supersedesId: null,
  conflictsWithIds: [], sensitivity: "internal", expirationPolicy: "never", expiresAt: null, createdAt: now, updatedAt: now,
};

function renderPage() {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/", component: MemoryPage });
  const router = createRouter({ history: createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([route]) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActiveProjectProvider>
        <RouterProvider router={router as AnyRouter} />
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

describe("Memory page", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows an honest empty state when there is no memory in a scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url === "/api/memory/settings") return Response.json({ autoCapture: true });
      if (url.includes("/memory")) return Response.json([]);
      return Response.json({});
    }));
    renderPage();
    expect(await screen.findByRole("heading", { name: "No memory in this scope" })).toBeVisible();
  });

  it("shows a record's content and reveals its source/provenance on demand, without deleting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url === "/api/memory/settings") return Response.json({ autoCapture: true });
      if (url.includes("/memory")) return Response.json([entry]);
      return Response.json({});
    }));
    const user = userEvent.setup();
    renderPage();
    expect((await screen.findAllByText("Uses pnpm workspaces.")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Why does this exist?" }));
    expect(await screen.findByText("You wrote this")).toBeVisible();
    expect(screen.getByText("2 times")).toBeVisible();
  });

  it("lets the user correct a learned memory in place", async () => {
    let current = entry;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url === "/api/memory/settings") return Response.json({ autoCapture: true });
      if (url === "/api/memory/mem-1" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        current = { ...current, content: body.content, normalizedContent: body.content.toLowerCase(), source: "user" };
        return Response.json(current);
      }
      if (url.includes("/memory")) return Response.json([current]);
      return Response.json({});
    }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit memory" });
    await user.clear(editor);
    await user.type(editor, "Uses pnpm and Turborepo.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findAllByText("Uses pnpm and Turborepo.")).length).toBeGreaterThan(0);
  });

  it("lets the user save a new memory by hand, and it appears in the list afterward", async () => {
    let saved: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url === "/api/memory/settings") return Response.json({ autoCapture: true });
      if (url.endsWith("/memory") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const created = { ...entry, id: "mem-new", scope: body.scope, content: body.content };
        saved = [...saved, created];
        return Response.json(created, { status: 201 });
      }
      if (url.includes("/memory")) return Response.json(saved);
      return Response.json({});
    }));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole("heading", { name: "No memory in this scope" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Save memory/ }));
    await user.type(screen.getByLabelText("What should Morrow remember?"), "I prefer concise answers.");
    await user.selectOptions(screen.getByLabelText("Scope"), "user_global");
    await user.click(screen.getByRole("button", { name: "Save memory" }));

    expect((await screen.findAllByText("I prefer concise answers.")).length).toBeGreaterThan(0);
  });

  it("explains automatic learning and lets the user turn it off", async () => {
    let autoCapture = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([project]);
      if (url === "/api/memory/settings" && init?.method === "PATCH") {
        autoCapture = JSON.parse(String(init.body)).autoCapture;
        return Response.json({ autoCapture });
      }
      if (url === "/api/memory/settings") return Response.json({ autoCapture });
      if (url.includes("/memory")) return Response.json([]);
      return Response.json({});
    }));
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole("checkbox", { name: "Learn useful memory automatically" });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/durable preferences and project facts/i)).toBeVisible();

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(autoCapture).toBe(false);
  });
});
