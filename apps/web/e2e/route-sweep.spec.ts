import { test, expect, type Page } from "@playwright/test";

/**
 * App-wide structural sweep: every route, across the width matrix, in both
 * colour schemes.
 *
 * This is deliberately *not* a screenshot comparison. Pixel baselines are
 * platform-pinned and go stale on every intentional design change, so they are
 * poor at catching the class of defect that actually ships: a layout that
 * overflows horizontally at some width, a route that renders no heading, or a
 * page that throws in the console. Those are asserted directly here, so the
 * check is meaningful on any machine and never needs regenerating.
 *
 * Two real defects were found by running this sweep by hand:
 *   - `/app/memory` (and every other unrecognised address) rendered the shell
 *     around an empty region with no heading, because the router had no
 *     not-found component.
 *   - The first-run home page told the user a project was missing while
 *     offering no way to create one.
 */
const ROUTES = [
  { path: "/app/", name: "home" },
  { path: "/app/chats", name: "chats" },
  { path: "/app/projects", name: "projects" },
  { path: "/app/missions", name: "missions" },
  { path: "/app/skills", name: "skills" },
  { path: "/app/memory", name: "memory" },
  { path: "/app/teams", name: "teams" },
  { path: "/app/connections", name: "connections" },
  { path: "/app/settings", name: "settings" },
  // Not a registered route: proves unrecognised addresses land somewhere real.
  { path: "/app/not-a-real-route", name: "unknown address" },
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "tablet", width: 820, height: 1100 },
  { name: "mobile", width: 390, height: 844 },
] as const;

/** Elements whose right edge extends past the viewport, i.e. horizontal spill. */
async function overflowReport(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const limit = de.clientWidth + 1;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => {
        // Decorative artwork is intentionally clipped beyond its frame and
        // cannot create an actionable or readable overflow defect.
        if (el.closest('[aria-hidden="true"]')) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.right > limit;
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
    return { scrollOverflow: de.scrollWidth - de.clientWidth, offenders };
  });
}

for (const viewport of VIEWPORTS) {
  for (const scheme of ["light", "dark"] as const) {
    for (const route of ROUTES) {
      test(`${route.name} — ${viewport.name} ${scheme}: no overflow, has a heading, no console errors`, async ({ page }) => {
        const consoleErrors: string[] = [];
        page.on("pageerror", (error) => consoleErrors.push(String(error)));
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });

        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: scheme });
        // SSE keeps the network open, so `networkidle` never settles here.
        await page.goto(route.path, { waitUntil: "domcontentloaded" });

        const explore = page.getByRole("button", { name: "Explore first" });
        if (await explore.isVisible()) await explore.click();

        // Every route must present a level-1 heading: it is the landmark screen
        // readers navigate by, and its absence is how the missing not-found
        // page went unnoticed.
        await expect(page.locator(".morrow-route-canvas").getByRole("heading", { level: 1 })).toBeVisible();

        const { scrollOverflow, offenders } = await overflowReport(page);
        expect(
          scrollOverflow,
          `${route.path} spills horizontally by ${scrollOverflow}px at ${viewport.width}px. Offenders: ${offenders.join(", ")}`,
        ).toBe(0);
        expect(offenders, `${route.path} has elements past the right edge`).toEqual([]);

        expect(consoleErrors.filter((text) => !text.includes("404")), `${route.path} logged console errors`).toEqual([]);
      });
    }
  }
}
