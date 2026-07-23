import { test, expect } from "@playwright/test";
import { loadState } from "./seed-state.js";

const state = loadState();

/**
 * Visual regression over a fully-seeded mission whose timestamps and content are
 * fixed, so snapshots are stable run-to-run on the same platform. Baselines are
 * Windows/Chromium-pinned; regenerate with `--update-snapshots` when the design
 * intentionally changes. Runs last (alphabetical) so no earlier test mutates the
 * result mission.
 */
test.describe.configure({ mode: "serial" });

const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 900, height: 1100 },
  { name: "mobile", width: 390, height: 844 },
] as const;

for (const vp of viewports) {
  test(`result mission overview — ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`/app/missions/${state.seed.resultMissionId}`);
    await expect(page.getByRole("heading", { name: "Completed with caveats" })).toBeVisible();
    await expect(page).toHaveScreenshot(`result-overview-${vp.name}.png`, { fullPage: true });
  });
}

test("result mission overview — dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/app/missions/${state.seed.resultMissionId}`);
  // The app theme follows the OS preference by default; confirm the shell picked
  // up dark before snapshotting.
  await expect(page.getByRole("heading", { name: "Completed with caveats" })).toBeVisible();
  await expect(page).toHaveScreenshot("result-overview-dark.png", { fullPage: true });
});
