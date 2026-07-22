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
  "Chats",
  "Projects",
  "Missions",
  "Library",
  "Memory",
  "Connections",
  "Settings",
];
const IMPLEMENTED = ["Home", "Chats", "Missions", "Library", "Connections", "Settings"];
const UPCOMING = ["Projects", "Memory"];

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
    renderAt("/app/missions");

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
    renderAt("/app/missions");

    expect(await screen.findByRole("link", { name: "Missions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("updates the title and focuses main content after client navigation", async () => {
    const user = userEvent.setup();
    renderAt("/app/");

    await waitFor(() => expect(document.title).toBe("Home · Morrow"));
    const main = screen.getByRole("main");
    expect(main).not.toHaveFocus();

    await user.click(await screen.findByRole("link", { name: "Missions" }));

    expect(
      await screen.findByRole("heading", { name: "Missions", level: 1 }),
    ).toBeVisible();
    await waitFor(() => {
      expect(document.title).toBe("Missions · Morrow");
      expect(main).toHaveFocus();
    });
  });

  it.each([
    ["/app/chats", "Chats"],
    ["/app/missions", "Missions"],
    ["/app/library", "Library"],
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

  it("applies a stored dark theme and switches to an explicit light choice", async () => {
    localStorage.setItem("morrow-theme", "dark");
    const user = userEvent.setup();
    renderAt("/app/settings");

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
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

  it("defaults to following the system and never rewrites an unset preference", async () => {
    renderAt("/app/settings");

    expect(await screen.findByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
    });
    expect(localStorage.getItem("morrow-theme")).toBeNull();
  });

  it("ignores an invalid stored theme and keeps following the system preference", async () => {
    localStorage.setItem("morrow-theme", "sepia");
    renderAt("/app/settings");

    expect(await screen.findByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
    });
    // The invalid value is ignored, not silently rewritten.
    expect(localStorage.getItem("morrow-theme")).toBe("sepia");
  });

  it("reports the local runtime health in the application shell", async () => {
    renderAt("/app/");

    expect(await screen.findByText("Runtime online")).toBeInTheDocument();
  });
});
