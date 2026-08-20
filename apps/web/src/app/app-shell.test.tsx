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

const NAV_ORDER = [
  "Home",
  "Projects",
  "Skills",
  "Memory",
  "History",
  "Connections",
  "Settings",
];
const IMPLEMENTED = NAV_ORDER;
const UPCOMING: string[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/health") {
        return new Response(JSON.stringify({ ok: true, service: "morrow-orchestrator" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.startsWith("/api/search?")) {
        return Response.json({
          version: 1,
          query: "database",
          total: 1,
          hits: [{
            kind: "conversation",
            refId: "conversation-1",
            projectId: "project-1",
            conversationId: "conversation-1",
            title: "Refactor the database layer",
            snippet: "Refactor the [database] layer",
            createdAt: "2026-08-12T12:00:00.000Z",
            score: -1,
          }],
        });
      }
      // No local project in shell tests: keeps the sidebar recent/new-chat data
      // resilient and avoids inventing conversations.
      return Response.json([]);
    }),
  );
}

function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
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
    stubFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the chat-first destinations in order and marks upcoming areas honestly", async () => {
    renderAt("/app/skills");

    const navigation = await screen.findByRole("navigation", { name: "Primary" });
    const labels = [...navigation.querySelectorAll("[data-nav]")].map((element) =>
      element.getAttribute("data-nav"),
    );
    expect(labels).toEqual(NAV_ORDER);

    for (const label of UPCOMING) {
      const control = within(navigation).getByRole("button", {
        name: new RegExp(`^${label}`),
      });
      expect(control).toBeDisabled();
      expect(within(control).getByText("Soon")).toBeVisible();
    }
    for (const label of IMPLEMENTED) {
      expect(within(navigation).getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the active route as the current page", async () => {
    renderAt("/app/skills");
    const navigation = await screen.findByRole("navigation", { name: "Primary" });

    expect(within(navigation).getByRole("link", { name: "Skills" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(navigation).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("keeps compact navigation understandable to assistive technology", async () => {
    renderAt("/app/skills");
    const navigation = await screen.findByRole("navigation", { name: "Primary" });
    const home = within(navigation).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("aria-label", "Home");
    expect(home).toHaveAttribute("title", "Home");
  });

  it("updates the title and focuses main content after client navigation", async () => {
    const user = userEvent.setup();
    renderAt("/app/");

    await waitFor(() => expect(document.title).toBe("Home · Morrow"));
    const main = screen.getByRole("main");
    expect(main).not.toHaveFocus();
    const navigation = await screen.findByRole("navigation", { name: "Primary" });

    await user.click(within(navigation).getByRole("link", { name: "Skills" }));

    expect(
      await screen.findByRole("heading", { name: "Skills", level: 1 }),
    ).toBeVisible();
    await waitFor(() => {
      expect(document.title).toBe("Skills · Morrow");
      expect(main).toHaveFocus();
    });
  });

  it.each([
    ["/app/chats", "History"],
    ["/app/projects", "Projects"],
    ["/app/skills", "Skills"],
    ["/app/connections", "Connect a model"],
    ["/app/settings", "Settings"],
  ])("renders %s inside the shared shell", async (path, heading) => {
    renderAt(path);

    expect(
      await screen.findByRole("heading", { name: heading, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("exposes an accessible mobile navigation toggle", async () => {
    const user = userEvent.setup();
    renderAt("/app/");

    const toggle = await screen.findByRole("button", { name: "Open navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(
      screen.getByRole("button", { name: "Close navigation" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("provides a compact mobile dock and exposes secondary navigation through More", async () => {
    const user = userEvent.setup();
    renderAt("/app/");

    const dock = await screen.findByRole("navigation", { name: "Mobile navigation" });
    expect(within(dock).getByRole("link", { name: "History" })).toBeVisible();
    await user.click(within(dock).getByRole("button", { name: "More navigation" }));
    expect(await screen.findByRole("button", { name: "Close navigation" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("mounts a mobile teammate switcher beside the route canvas", async () => {
    renderAt("/app/");

    await waitFor(() => expect(document.querySelector(".morrow-mobile-roster")).toBeInTheDocument());
  });

  it("opens global search from the keyboard and exposes a real conversation destination", async () => {
    const user = userEvent.setup();
    renderAt("/app/");

    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("searchbox", { name: "Search Morrow" });
    expect(search).toHaveFocus();
    await user.type(search, "database");

    const result = await screen.findByRole("link", { name: /Refactor the database layer/i });
    expect(result).toHaveAttribute("href", "/app/chats/conversation-1?projectId=project-1");
  });

  it("applies a stored dark theme and switches to an explicit light choice", async () => {
    localStorage.setItem("morrow-theme", "dark");
    const user = userEvent.setup();
    renderAt("/app/settings");

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
    await user.click(await screen.findByRole("button", { name: /^Appearance/ }));
    const darkChoice = await screen.findByRole("button", { name: "Dark" });
    expect(darkChoice).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Light" }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
    });
    expect(localStorage.getItem("morrow-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "false");
  });

  it("defaults new installs to dark and never rewrites an unset preference", async () => {
    const user = userEvent.setup();
    renderAt("/app/settings");

    await user.click(await screen.findByRole("button", { name: /^Appearance/ }));
    expect(await screen.findByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
    expect(localStorage.getItem("morrow-theme")).toBeNull();
  });

  it("ignores an invalid stored theme and keeps the graphite default", async () => {
    localStorage.setItem("morrow-theme", "sepia");
    const user = userEvent.setup();
    renderAt("/app/settings");

    await user.click(await screen.findByRole("button", { name: /^Appearance/ }));
    expect(await screen.findByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
    // The invalid value is ignored, not silently rewritten.
    expect(localStorage.getItem("morrow-theme")).toBe("sepia");
  });

  it("reports the local runtime health in the application shell", async () => {
    renderAt("/app/");

    expect(await screen.findByText("Runtime online")).toBeInTheDocument();
  });

  it("integrates workspace and runtime context into the shell without a dashboard status strip", async () => {
    renderAt("/app/");

    expect(
      await screen.findByRole("link", { name: "Current workspace: No project selected" }),
    ).toHaveAttribute("href", "/app/projects");
    expect(screen.getByRole("status", { name: "Morrow runtime: Runtime online" })).toBeVisible();
    expect(screen.queryByText("Choose a project to begin")).not.toBeInTheDocument();
    expect(document.querySelector(".morrow-workspace-context")).toBeNull();
    expect(screen.getByRole("link", { name: "Choose a project" })).toHaveAttribute("href", "/app/projects");
  });
});

describe("unknown addresses", () => {
  /**
   * A stale bookmark or a mistyped path used to render the shell around an
   * empty content region: no heading, no explanation, no way back — and no
   * landmark for a screen reader to find.
   */
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
  });

  it("explains an unrecognised address and offers a way back", async () => {
    renderAt("/nonexistent-page");

    expect(await screen.findByRole("heading", { level: 1, name: /isn’t here/i })).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to Home" })).toBeVisible();
  });
});
