import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  type AnyRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "./providers.js";
import { createAppRouter } from "./router.js";

const navigationLabels = [
  "Home",
  "Missions",
  "Library",
  "Automations",
  "Workspace",
  "Connections",
  "Settings",
];

function healthyResponse(): Response {
  return new Response(
    JSON.stringify({ ok: true, service: "morrow-orchestrator" }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    },
  );
}

function renderAt(path: string) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );

  render(
    <AppProviders>
      <RouterProvider router={router as AnyRouter} />
    </AppProviders>,
  );

  return router;
}

describe("Morrow application shell", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    vi.stubGlobal("fetch", vi.fn(async () => healthyResponse()));
  });

  it("renders all seven approved navigation labels in order", async () => {
    renderAt("/app/missions");

    const navigation = await screen.findByRole("navigation", {
      name: "Primary",
    });
    expect(
      within(navigation)
        .getAllByRole("link")
        .map((link) => link.textContent?.trim()),
    ).toEqual(navigationLabels);
  });

  it("marks the active route as the current page", async () => {
    renderAt("/app/missions");

    expect(
      await screen.findByRole("link", { name: "Missions" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it.each([
    ["/app/", "Home"],
    ["/app/missions", "Missions"],
    ["/app/missions/mission-42", "Mission workspace"],
    ["/app/library", "Library"],
    ["/app/automations", "Automations"],
    ["/app/workspace", "Workspace"],
    ["/app/connections", "Connections"],
    ["/app/settings", "Settings"],
  ])("renders %s inside the shared shell", async (path, heading) => {
    renderAt(path);

    expect(
      await screen.findByRole("heading", { name: heading, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("applies and persists the global theme without unrelated storage writes", async () => {
    localStorage.setItem("morrow-theme", "dark");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setItem.mockClear();
    const user = userEvent.setup();

    renderAt("/app/settings");

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
    await user.click(
      await screen.findByRole("button", { name: "Use light theme" }),
    );

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
    });
    expect(localStorage.getItem("morrow-theme")).toBe("light");
    expect(setItem.mock.calls.every(([key]) => key === "morrow-theme")).toBe(
      true,
    );
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      ),
    ).toEqual(["morrow-theme"]);
  });

  it("reports the local runtime health in the application shell", async () => {
    renderAt("/app/");

    expect(await screen.findByText("Runtime online")).toBeInTheDocument();
  });
});
