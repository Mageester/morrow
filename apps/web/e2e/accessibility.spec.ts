import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { loadState } from "./seed-state.js";

const state = loadState();

// This file is intentionally ordered before mission-vertical-slice.spec.ts
// (alphabetical, workers=1) so the seeded attention request is still pending
// when the destructive-dialog focus test opens (and cancels) it.
test.describe.configure({ mode: "serial" });

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

test("Home has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/app/");
  await expect(page.getByRole("heading", { name: "What should Morrow accomplish?" })).toBeVisible();
  const violations = await seriousViolations(page);
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("Mission workspace with an attention request has no serious or critical violations", async ({ page }) => {
  await page.goto(`/app/missions/${state.seed.attentionMissionId}`);
  await expect(page.getByRole("heading", { name: "Waiting for your approval" })).toBeVisible();
  const violations = await seriousViolations(page);
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("Result mission page has no serious or critical violations", async ({ page }) => {
  await page.goto(`/app/missions/${state.seed.resultMissionId}`);
  // The result panel is inline for a completed mission — no tab to activate.
  await expect(page.getByRole("heading", { name: "Completed with caveats" })).toBeVisible();
  const violations = await seriousViolations(page);
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("a destructive attention choice traps focus and restores it on cancel", async ({ page }) => {
  await page.goto(`/app/missions/${state.seed.attentionMissionId}`);
  const deny = page.getByRole("button", { name: "Deny" });
  await deny.click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  // Focus starts on Cancel, never on the confirming/destructive action.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Focus returns to the invoking choice.
  await expect(deny).toBeFocused();
});
