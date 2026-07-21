import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  type AnyRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { missionKeys } from "../../api/query-keys.js";
import { RuntimeStatusProvider } from "../../state/runtime-status.js";
import { ThemeProvider } from "../../state/theme.js";
import { createAppRouter } from "../../app/router.js";

const now = "2026-07-21T12:00:00.000Z";

const project = {
  createdAt: now,
  id: "project-1",
  name: "Private workspace",
  version: 1,
  workspacePath: "C:\\private\\workspace",
};

function mission(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    attentionCount: 0,
    completedMilestones: 0,
    createdAt: now,
    currentPhase: "Planning",
    id,
    latestActivity: "Morrow is getting started.",
    objective: `Objective for ${id}`,
    projectId: project.id,
    state: "working",
    title: `Mission ${id}`,
    totalMilestones: 2,
    updatedAt: now,
    version: 1,
    workspaceId: "workspace-personal-project-1",
    ...overrides,
  };
}

function snapshot(id = "mission-created") {
  return {
    artifacts: [],
    attention: [],
    currentWork: null,
    milestones: [],
    recentActivity: [],
    summary: mission(id),
    verification: {
      caveats: [],
      evidenceCount: 0,
      state: "not_ready",
      summary: "Verification has not started.",
    },
    version: 1,
  };
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function installApi(
  handler: (path: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderHome() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: ["/app/"] }),
  );

  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RuntimeStatusProvider>
          <RouterProvider router={router as AnyRouter} />
        </RuntimeStatusProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );

  return { queryClient, router };
}

function standardHandler(
  missions: ReturnType<typeof mission>[] = [],
  createResponse: Response = json(snapshot(), 201),
) {
  return (path: string) => {
    if (path === "/api/health") {
      return json({ ok: true, service: "morrow-orchestrator" });
    }
    if (path === "/api/projects") return json([project]);
    if (path.startsWith("/api/web/missions?")) return json(missions);
    if (path === "/api/web/missions") return createResponse;
    throw new Error(`Unexpected request: ${path}`);
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HomePage", () => {
  it("uses the universal objective-first prompt without a task category selector", async () => {
    installApi(standardHandler());
    renderHome();

    const objective = await screen.findByRole("textbox", {
      name: "Mission objective",
    });
    expect(screen.getByText("What should Morrow accomplish?")).toBeVisible();
    await waitFor(() => expect(objective).toHaveFocus());
    expect(screen.queryByText(/Coding|Research|Documents/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start mission" })).toBeDisabled();
  });

  it("blocks an empty submission", async () => {
    const fetchMock = installApi(standardHandler());
    const user = userEvent.setup();
    renderHome();

    const objective = await screen.findByRole("textbox", {
      name: "Mission objective",
    });
    await user.keyboard("{Enter}");

    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/web/missions"),
    ).toHaveLength(0);
  });

  it("submits with Enter while Shift+Enter adds a newline", async () => {
    const fetchMock = installApi(standardHandler());
    const user = userEvent.setup();
    renderHome();

    const objective = await screen.findByRole("textbox", {
      name: "Mission objective",
    });
    await user.type(objective, "Plan the release notes");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(objective).toHaveValue("Plan the release notes\n");
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/web/missions"),
    ).toHaveLength(0);

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([path]) => path === "/api/web/missions"),
      ).toHaveLength(1);
    });
  });

  it("uses one stable idempotency key for rapid double submission and caches the created mission", async () => {
    const created = deferred<Response>();
    const fetchMock = installApi((path) => {
      if (path === "/api/health") {
        return json({ ok: true, service: "morrow-orchestrator" });
      }
      if (path === "/api/projects") return json([project]);
      if (path.startsWith("/api/web/missions?")) return json([]);
      if (path === "/api/web/missions") return created.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const { queryClient, router } = renderHome();
    const user = userEvent.setup();

    const objective = await screen.findByRole("textbox", {
      name: "Mission objective",
    });
    await user.type(objective, "Prepare the release");
    await user.keyboard("{Enter}{Enter}");

    const creates = fetchMock.mock.calls.filter(
      ([path]) => path === "/api/web/missions",
    );
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0]?.[1]?.body))).toMatchObject({
      idempotencyKey: expect.any(String),
      objective: "Prepare the release",
      projectId: project.id,
    });

    created.resolve(json(snapshot("mission-42"), 201));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/missions/mission-42");
    });
    expect(queryClient.getQueryData(missionKeys.detail("mission-42"))).toEqual(
      snapshot("mission-42"),
    );
  });

  it("preserves a failed objective and rotates the idempotency key only after an explicit edit", async () => {
    let createCount = 0;
    const fetchMock = installApi((path) => {
      if (path === "/api/health") {
        return json({ ok: true, service: "morrow-orchestrator" });
      }
      if (path === "/api/projects") return json([project]);
      if (path.startsWith("/api/web/missions?")) return json([]);
      if (path === "/api/web/missions") {
        createCount += 1;
        return createCount < 3
          ? json(
              {
                error: {
                  code: "MISSION_BLOCKED",
                  message: "The mission needs a decision.",
                },
                version: 1,
              },
              409,
            )
          : json(snapshot("mission-retry"), 201);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    renderHome();

    const objective = await screen.findByRole("textbox", {
      name: "Mission objective",
    });
    await user.type(objective, "Review the proposal");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The mission needs a decision.",
    );
    expect(objective).toHaveValue("Review the proposal");

    const first = JSON.parse(
      String(
        fetchMock.mock.calls.find(([path]) => path === "/api/web/missions")?.[1]
          ?.body,
      ),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(createCount).toBe(2));
    const retry = JSON.parse(
      String(
        fetchMock.mock.calls.filter(([path]) => path === "/api/web/missions")[1]?.[1]
          ?.body,
      ),
    );
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);

    await user.type(objective, " with evidence");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(createCount).toBe(3));
    const second = JSON.parse(
      String(fetchMock.mock.calls.filter(([path]) => path === "/api/web/missions")[2]?.[1]?.body),
    );
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("rotates the idempotency key when autonomy changes after a failed request", async () => {
    let createCount = 0;
    const fetchMock = installApi((path) => {
      if (path === "/api/health") {
        return json({ ok: true, service: "morrow-orchestrator" });
      }
      if (path === "/api/projects") return json([project]);
      if (path.startsWith("/api/web/missions?")) return json([]);
      if (path === "/api/web/missions") {
        createCount += 1;
        return createCount === 1
          ? json(
              {
                error: {
                  code: "MISSION_BLOCKED",
                  message: "The mission needs a decision.",
                },
                version: 1,
              },
              409,
            )
          : json(snapshot("mission-autonomy"), 201);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const user = userEvent.setup();
    renderHome();

    const objective = await screen.findByRole("textbox", {
      name: "Mission objective",
    });
    await user.type(objective, "Review the proposal");
    await user.keyboard("{Enter}");
    await screen.findByRole("alert");
    const first = JSON.parse(
      String(
        fetchMock.mock.calls.find(([path]) => path === "/api/web/missions")?.[1]
          ?.body,
      ),
    );

    await user.selectOptions(
      screen.getByLabelText("Autonomy"),
      "autonomous",
    );
    await user.click(screen.getByRole("button", { name: "Start mission" }));
    await waitFor(() => expect(createCount).toBe(2));
    const changed = JSON.parse(
      String(fetchMock.mock.calls.filter(([path]) => path === "/api/web/missions")[1]?.[1]?.body),
    );
    expect(changed.autonomy).toBe("autonomous");
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("keeps the deadline disabled and never submits it before the service supports deadlines", async () => {
    const fetchMock = installApi(standardHandler());
    const user = userEvent.setup();
    renderHome();

    const deadline = await screen.findByLabelText("Optional deadline");
    expect(deadline).toBeDisabled();
    await user.click(screen.getByText("Advanced mission options"));
    expect(
      screen.getByText(
        "Deadlines, attachments, and connections are not available in this local slice.",
      ),
    ).toBeVisible();
    fireEvent.change(deadline, { target: { value: "2026-07-22T12:00" } });
    const objective = screen.getByRole("textbox", { name: "Mission objective" });
    await user.type(objective, "Plan the release");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([path]) => path === "/api/web/missions"),
      ).toHaveLength(1);
    });
    expect(
      JSON.parse(
        String(
          fetchMock.mock.calls.find(([path]) => path === "/api/web/missions")?.[1]
            ?.body,
        ),
      ),
    ).not.toHaveProperty("deadline");
  });

  it("rejects an oversized objective before locking submission and allows a corrected retry", async () => {
    const fetchMock = installApi(standardHandler());
    renderHome();

    const objective = await screen.findByRole("textbox", {
      name: "Mission objective",
    });
    fireEvent.change(objective, { target: { value: "x".repeat(8_001) } });
    await waitFor(() => expect(objective).toHaveValue("x".repeat(8_001)));
    fireEvent.keyDown(objective, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Mission objectives must be 8,000 characters or fewer.",
    );
    expect(objective).toHaveAttribute("aria-invalid", "true");
    expect(objective).toHaveValue("x".repeat(8_001));
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/web/missions"),
    ).toHaveLength(0);

    fireEvent.change(objective, { target: { value: "x".repeat(8_000) } });
    await waitFor(() => expect(objective).toHaveValue("x".repeat(8_000)));
    fireEvent.keyDown(objective, { key: "Enter" });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([path]) => path === "/api/web/missions"),
      ).toHaveLength(1);
    });
    expect(
      JSON.parse(
        String(
          fetchMock.mock.calls.find(([path]) => path === "/api/web/missions")?.[1]
            ?.body,
        ),
      ).objective,
    ).toHaveLength(8_000);
  });

  it("renders non-empty home sections in attention, active, then recent-result order", async () => {
    installApi(
      standardHandler([
        mission("attention", {
          attentionCount: 1,
          state: "needs_input",
          title: "Approve a connection",
        }),
        mission("active", { title: "Draft a plan" }),
        mission("complete", {
          state: "completed_verified",
          title: "Completed research",
        }),
      ]),
    );
    renderHome();

    await screen.findByText("Approve a connection");
    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(
      expect.arrayContaining([
        "Needs your attention",
        "Active missions",
        "Recent results",
      ]),
    );
    const content = document.body.textContent ?? "";
    expect(content.indexOf("Needs your attention")).toBeLessThan(
      content.indexOf("Active missions"),
    );
    expect(content.indexOf("Active missions")).toBeLessThan(
      content.indexOf("Recent results"),
    );
    expect(screen.getByText("Approve a connection")).toBeVisible();
    expect(screen.getByText("Draft a plan")).toBeVisible();
    expect(screen.getByText("Completed research")).toBeVisible();
  });

  it("places a working mission that needs attention only in the attention landmark", async () => {
    installApi(
      standardHandler([
        mission("working-attention", {
          attentionCount: 1,
          title: "Choose a deployment window",
        }),
        mission("active", { title: "Continue research" }),
        mission("complete", {
          state: "completed_verified",
          title: "Finished review",
        }),
      ]),
    );
    renderHome();

    const attention = await screen.findByRole("region", {
      name: "Needs your attention",
    });
    const active = screen.getByRole("region", { name: "Active missions" });
    const results = screen.getByRole("region", { name: "Recent results" });
    expect(attention).toHaveAttribute("aria-labelledby", "home-attention-heading");
    expect(active).toHaveAttribute("aria-labelledby", "home-active-heading");
    expect(results).toHaveAttribute("aria-labelledby", "home-results-heading");
    expect(
      screen.getAllByRole("link", { name: "Choose a deployment window" }),
    ).toHaveLength(1);
    expect(within(active).queryByText("Choose a deployment window")).not.toBeInTheDocument();
  });

  it("hides empty mission sections and teaches the empty state", async () => {
    installApi(standardHandler());
    renderHome();

    expect(await screen.findByText("Start with an outcome.")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Needs your attention" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Active missions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Recent results" }),
    ).not.toBeInTheDocument();
  });

  it("handles unavailable and failed project loading without exposing workspace details", async () => {
    installApi((path) => {
      if (path === "/api/health") {
        return json({ ok: true, service: "morrow-orchestrator" });
      }
      if (path === "/api/projects") return json([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    renderHome();

    expect(await screen.findByText("No project is available yet.")).toBeVisible();
    expect(screen.getByText("No local project is available yet.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(
      screen.queryByText("Select or create a local project before starting a mission."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(project.workspacePath)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start mission" })).toBeDisabled();
  });

  it("shows a recoverable project-loading error", async () => {
    installApi((path) => {
      if (path === "/api/health") {
        return json({ ok: true, service: "morrow-orchestrator" });
      }
      if (path === "/api/projects") return json({ unexpected: true });
      throw new Error(`Unexpected request: ${path}`);
    });
    renderHome();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Projects could not be loaded.",
    );
    expect(
      screen.queryByText("Select or create a local project before starting a mission."),
    ).not.toBeInTheDocument();
  });

  it("announces project loading before resolving an empty local-project state", async () => {
    const projects = deferred<Response>();
    installApi((path) => {
      if (path === "/api/health") {
        return json({ ok: true, service: "morrow-orchestrator" });
      }
      if (path === "/api/projects") return projects.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    renderHome();

    expect(await screen.findByText("Loading local projects…")).toHaveAttribute(
      "role",
      "status",
    );
    expect(
      screen.queryByText("Select or create a local project before starting a mission."),
    ).not.toBeInTheDocument();
    projects.resolve(json([]));
    expect(await screen.findByText("No local project is available yet.")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("caches a late success without navigating away from the page the user already chose", async () => {
    const created = deferred<Response>();
    installApi((path) => {
      if (path === "/api/health") {
        return json({ ok: true, service: "morrow-orchestrator" });
      }
      if (path === "/api/projects") return json([project]);
      if (path.startsWith("/api/web/missions?")) return json([]);
      if (path === "/api/web/missions") return created.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const { queryClient, router } = renderHome();
    const user = userEvent.setup();
    const objective = await screen.findByRole("textbox", {
      name: "Mission objective",
    });
    await user.type(objective, "Prepare the release");
    await user.keyboard("{Enter}");

    await router.navigate({ to: "/library" });
    created.resolve(json(snapshot("mission-late"), 201));
    await waitFor(() => {
      expect(queryClient.getQueryData(missionKeys.detail("mission-late"))).toEqual(
        snapshot("mission-late"),
      );
    });
    expect(router.state.location.pathname).toBe("/library");
  });
});
