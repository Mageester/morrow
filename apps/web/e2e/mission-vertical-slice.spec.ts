import { test, expect } from "@playwright/test";
import { loadState } from "./seed-state.js";

const state = loadState();

test.describe.configure({ mode: "serial" });

test.describe("Morrow web vertical slice", () => {
  test("Home renders the universal objective-first composer and approved navigation", async ({ page }) => {
    await page.goto("/app/");
    await expect(page.getByRole("heading", { name: "What should Morrow accomplish?" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Home", "Missions", "Library", "Automations", "Workspace", "Connections", "Settings"]) {
      await expect(nav.getByRole("link", { name: label })).toBeVisible();
    }
    // No task-type selector — Morrow is a general agent, not a coding-only tool.
    await expect(page.getByText(/Coding|Research|Documents/)).toHaveCount(0);
  });

  test("creates a mission through the composer and lands on its durable workspace", async ({ page }) => {
    await page.goto("/app/");
    await page.getByLabel("Mission objective").fill("Compare three note-taking apps and recommend one.");
    const start = page.getByRole("button", { name: "Start mission" });
    await expect(start).toBeEnabled();
    await start.click();

    await expect(page).toHaveURL(/\/app\/missions\/mission-/);
    await expect(page.getByRole("heading", { name: "Compare three note-taking apps and recommend one." })).toBeVisible();

    // At least one durable, human-readable activity item exists.
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByRole("list", { name: "Mission activity" }).getByRole("listitem").first()).toBeVisible();
    await expect(page.getByText(/Mission created:/)).toBeVisible();
  });

  test("a refresh recovers the same mission and state", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.attentionMissionId}`);
    await expect(page.getByRole("heading", { name: "Research three competitors and prepare a concise report." })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(new RegExp(state.seed.attentionMissionId));
    await expect(page.getByRole("heading", { name: "Research three competitors and prepare a concise report." })).toBeVisible();
  });

  test("reports offline then recovers to online when the runtime connection drops", async ({ page, context }) => {
    await page.goto("/app/");
    await expect(page.getByText("Runtime online")).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText("Runtime offline")).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText("Runtime online")).toBeVisible();
  });

  test("resolves a seeded attention request without auto-selecting the recommendation", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.attentionMissionId}`);
    const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Waiting for your approval" }) });
    await expect(card).toBeVisible();
    // The recommendation is shown but never auto-selected/submitted.
    await expect(card.getByRole("button", { name: /Approve/ })).toBeEnabled();
    await expect(card.getByRole("button", { name: "Deny" })).toBeEnabled();

    await card.getByRole("button", { name: /Approve/ }).click();
    // After a durable resolution the request is no longer pending.
    await expect(page.getByText("No attention is needed right now.")).toBeVisible();
  });

  test("inspects the seeded result artifact through the Work tab", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.resultMissionId}`);
    await page.getByRole("tab", { name: "Work" }).click();
    // The artifact title is an <h3> in the Work tab (an <h4> in Result); target
    // the Work-tab heading level to disambiguate.
    await expect(page.getByRole("heading", { name: state.seed.artifactTitle, level: 3 })).toBeVisible();
  });

  test("Result honestly reports completion with caveats and shows evidence", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.resultMissionId}`);
    await expect(page.getByRole("heading", { name: "Completed with caveats" })).toBeVisible();
    await page.getByRole("tab", { name: "Result" }).click();
    const resultPanel = page.getByRole("tabpanel").filter({ has: page.getByRole("heading", { name: "Verification" }) });
    await expect(resultPanel.getByRole("heading", { name: "Verification" })).toBeVisible();
    // Honest: never claims a plain "Completed and verified" headline for a caveated mission.
    await expect(page.getByRole("heading", { name: "Completed and verified", exact: true })).toHaveCount(0);
  });

  test("supports keyboard-only navigation across the mission tabs", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.resultMissionId}`);
    const overview = page.getByRole("tab", { name: "Overview" });
    await overview.focus();
    await expect(overview).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Activity" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "Result" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "Overview" })).toBeFocused();
  });

  test("never fabricates a numeric progress percentage", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.resultMissionId}`);
    // Honesty gate: the UI reports milestone counts, never an invented "NN%".
    await expect(page.getByText(/\b\d{1,3}\s*%/)).toHaveCount(0);
  });
});
