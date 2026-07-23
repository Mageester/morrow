import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveProjectProvider } from "../../state/active-project.js";
import { useActiveProject } from "./use-active-project.js";

const now = "2026-07-23T12:00:00.000Z";
const projectA = { id: "project-a", name: "Alpha", version: 1, workspacePath: "C:\\alpha", createdAt: now };
const projectB = { id: "project-b", name: "Beta", version: 1, workspacePath: "C:\\beta", createdAt: now };

function stubProjectsFetch(projects: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return Response.json(projects);
      throw new Error(`unexpected ${url}`);
    }),
  );
}

function renderActiveProject() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useActiveProject(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <ActiveProjectProvider>{children}</ActiveProjectProvider>
      </QueryClientProvider>
    ),
  });
}

describe("useActiveProject", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("falls back to the first-created project when nothing has ever been selected", async () => {
    stubProjectsFetch([projectA, projectB]);
    const { result } = renderActiveProject();

    await waitFor(() => expect(result.current.activeProject?.id).toBe("project-a"));
    expect(result.current.projects).toHaveLength(2);
  });

  it("honors an explicit selection over the first project", async () => {
    stubProjectsFetch([projectA, projectB]);
    const { result } = renderActiveProject();
    await waitFor(() => expect(result.current.activeProject?.id).toBe("project-a"));

    act(() => result.current.selectProject("project-b"));

    await waitFor(() => expect(result.current.activeProject?.id).toBe("project-b"));
  });

  it("persists the selection across a remount via localStorage", async () => {
    stubProjectsFetch([projectA, projectB]);
    const first = renderActiveProject();
    await waitFor(() => expect(first.result.current.activeProject?.id).toBe("project-a"));
    act(() => first.result.current.selectProject("project-b"));
    await waitFor(() => expect(first.result.current.activeProject?.id).toBe("project-b"));
    first.unmount();

    const second = renderActiveProject();
    await waitFor(() => expect(second.result.current.activeProject?.id).toBe("project-b"));
  });

  it("falls back to the first project when the stored selection no longer exists", async () => {
    localStorage.setItem("morrow-active-project", "project-deleted");
    stubProjectsFetch([projectA, projectB]);
    const { result } = renderActiveProject();

    await waitFor(() => expect(result.current.activeProject?.id).toBe("project-a"));
  });
});
