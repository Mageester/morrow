import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  type AnyRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "./providers.js";
import { createAppRouter } from "./router.js";

// Ready product areas lead; visibly-incomplete areas are grouped after them
// and marked "Soon" so they never masquerade as finished features.
const navigationLabels = [
  "Home",
  "Missions",
  "Connections",
  "Settings",
  "Library",
  "Automations",
  "Workspace",
];
const previewLabels = ["Library", "Automations", "Workspace"];

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
    document.title = "Morrow";
    vi.stubGlobal("fetch", vi.fn(async () => healthyResponse()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all seven navigation labels in order, marking unfinished areas as Soon", async () => {
    renderAt("/app/missions");

    const navigation = await screen.findByRole("navigation", {
      name: "Primary",
    });
    const links = within(navigation).getAllByRole("link");
    // The label lives in the link's first span; a preview link also carries a
    // trailing "Soon" badge span, so read the label span explicitly.
    expect(
      links.map((link) => link.querySelector("span")?.textContent?.trim()),
    ).toEqual(navigationLabels);

    for (const label of previewLabels) {
      const link = within(navigation).getByRole("link", { name: new RegExp(`^${label}`) });
      expect(link).toHaveAttribute("data-preview", "true");
      expect(within(link).getByText("Soon")).toBeVisible();
    }
    for (const label of ["Home", "Missions", "Connections", "Settings"]) {
      expect(
        within(navigation).getByRole("link", { name: label }),
      ).not.toHaveAttribute("data-preview");
    }
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

  it("updates the title and focuses main content after client navigation", async () => {
    const user = userEvent.setup();
    renderAt("/app/");

    expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
    const main = screen.getByRole("main");
    expect(document.title).toBe("Home · Morrow");
    expect(main).not.toHaveFocus();

    await user.click(screen.getByRole("link", { name: "Missions" }));

    expect(
      await screen.findByRole("heading", { name: "Missions", level: 1 }),
    ).toBeVisible();
    await waitFor(() => {
      expect(document.title).toBe("Missions · Morrow");
      expect(main).toHaveFocus();
    });
  });

  it.each([
    ["/app/", "Home"],
    ["/app/missions", "Missions"],
    ["/app/missions/mission-42", "Mission workspace"],
    ["/app/library", "Library"],
    ["/app/automations", "Automations"],
    ["/app/workspace", "Workspace"],
    ["/app/connections", "Connect a model"],
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
    const themeToggle = await screen.findByRole("button", {
      name: "Switch to light theme",
    });
    expect(themeToggle).toHaveAttribute("aria-pressed", "true");
    await user.click(themeToggle);

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
    });
    expect(localStorage.getItem("morrow-theme")).toBe("light");
    expect(themeToggle).toHaveAttribute("aria-pressed", "false");
    expect(setItem.mock.calls.every(([key]) => key === "morrow-theme")).toBe(
      true,
    );
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      ),
    ).toEqual(["morrow-theme"]);
  });

  it("uses stable pressed semantics for the dark theme preference", async () => {
    const user = userEvent.setup();
    renderAt("/app/settings");

    const themeToggle = await screen.findByRole("button", {
      name: "Switch to dark theme",
    });
    expect(themeToggle).toHaveAttribute("aria-pressed", "false");

    await user.click(themeToggle);

    expect(themeToggle).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("ignores an invalid stored theme and keeps following the system preference", async () => {
    localStorage.setItem("morrow-theme", "sepia");

    renderAt("/app/settings");

    expect(
      await screen.findByRole("button", { name: "Switch to dark theme" }),
    ).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
    });
    // The invalid value is ignored, not silently rewritten: nothing is
    // persisted until the user makes an explicit choice.
    expect(localStorage.getItem("morrow-theme")).toBe("sepia");
  });

  it("reports the local runtime health in the application shell", async () => {
    renderAt("/app/");

    expect(await screen.findByText("Runtime online")).toBeInTheDocument();
  });
});
