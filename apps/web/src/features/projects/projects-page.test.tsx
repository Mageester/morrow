import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveProjectProvider } from "../../state/active-project.js";
import { ProjectsPage } from "./projects-page.js";

const now = "2026-07-23T12:00:00.000Z";
const projectA = { id: "project-a", name: "Alpha", version: 1, workspacePath: "C:\\code\\alpha", createdAt: now };
const projectB = { id: "project-b", name: "Beta", version: 1, workspacePath: "C:\\code\\beta", createdAt: now };

function renderProjects(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ActiveProjectProvider>
        <ProjectsPage />
      </ActiveProjectProvider>
    </QueryClientProvider>,
  );
}

function statusFor(project: { id: string; name: string; workspacePath: string }, overrides: Record<string, unknown> = {}) {
  return {
    id: project.id,
    name: project.name,
    workspacePath: project.workspacePath,
    accessible: true,
    gitDetected: false,
    branch: null,
    ...overrides,
  };
}

describe("ProjectsPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows an honest empty state and lets the user add the first project", async () => {
    let created = false;
    renderProjects(async (input, init) => {
      const url = String(input);
      if (url === "/api/projects" && init?.method === "POST") {
        created = true;
        return Response.json(projectA);
      }
      if (url === "/api/projects") return Response.json(created ? [projectA] : []);
      if (url === `/api/projects/${projectA.id}/status`) return Response.json(statusFor(projectA));
      throw new Error(`unexpected ${url}`);
    });

    expect(await screen.findByText(/No projects yet/i)).toBeVisible();

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: /project name/i }), "Alpha");
    await user.type(screen.getByRole("textbox", { name: /folder path/i }), "C:\\code\\alpha");
    await user.click(screen.getByRole("button", { name: /add project/i }));

    expect(await screen.findByText("Alpha")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
  });

  it("lists existing projects, marks the active one, and lets the user switch", async () => {
    renderProjects(async (input) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([projectA, projectB]);
      if (url === `/api/projects/${projectA.id}/status`) return Response.json(statusFor(projectA, { gitDetected: true, branch: "main" }));
      if (url === `/api/projects/${projectB.id}/status`) return Response.json(statusFor(projectB));
      throw new Error(`unexpected ${url}`);
    });

    const rowA = (await screen.findByText("Alpha")).closest("li")!;
    const rowB = screen.getByText("Beta").closest("li")!;
    expect(within(rowA).getByText("Active")).toBeVisible();
    expect(await within(rowA).findByText("main")).toBeVisible();
    expect(within(rowB).queryByText("Active")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(rowB).getByRole("button", { name: /use this project/i }));

    await waitFor(() => expect(within(rowB).getByText("Active")).toBeVisible());
    expect(within(rowA).queryByText("Active")).not.toBeInTheDocument();
  });

  it("surfaces an inaccessible workspace as a real blocker, not a silent success", async () => {
    renderProjects(async (input) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json([projectA]);
      if (url === `/api/projects/${projectA.id}/status`) {
        return Response.json(statusFor(projectA, { accessible: false }));
      }
      throw new Error(`unexpected ${url}`);
    });

    expect(await screen.findByText(/not accessible right now/i)).toBeVisible();
  });
});
