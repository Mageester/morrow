import { test, expect } from "@playwright/test";
import { loadState } from "./seed-state.js";

const state = loadState();

test.describe.configure({ mode: "serial" });

test.describe("Morrow web vertical slice", () => {
  test("Home renders the objective-first composer and the reordered navigation", async ({ page }) => {
    await page.goto("/app/");
    await expect(page.getByRole("heading", { name: "What should Morrow accomplish?" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary" });
    // Ready areas lead; unfinished areas follow and are honestly marked "Soon".
    for (const label of ["Home", "Missions", "Connections", "Settings", "Library", "Automations", "Workspace"]) {
      await expect(nav.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: /^Library/ })).toHaveAttribute("data-preview", "true");
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
    await expect(
      page.getByRole("heading", { level: 1, name: "Compare three note-taking apps and recommend one." }),
    ).toBeVisible();

    // The live progress stream carries a durable, human-readable activity item
    // inline — there is no tab to hunt through.
    await expect(page.getByRole("heading", { name: "Live progress" })).toBeVisible();
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

  test("surfaces a seeded decision in the Waiting-on-you region without auto-selecting it", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.attentionMissionId}`);
    const region = page.getByRole("region", { name: "Waiting on you" });
    const card = region
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Waiting for your approval" }) });
    await expect(card).toBeVisible();
    // The recommendation is shown but never auto-selected/submitted.
    await expect(card.getByRole("button", { name: /Approve/ })).toBeEnabled();
    await expect(card.getByRole("button", { name: "Deny" })).toBeEnabled();

    await card.getByRole("button", { name: /Approve/ }).click();
    // After a durable resolution the decision no longer waits on the user.
    await expect(page.getByRole("heading", { name: "Waiting for your approval" })).toHaveCount(0);
  });

  test("surfaces the seeded result artifact as a deliverable", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.resultMissionId}`);
    // The completed mission leads with its result panel; the artifact is a
    // heading there, and also listed in the context rail's Deliverables.
    await expect(
      page.getByRole("heading", { name: state.seed.artifactTitle, level: 4 }),
    ).toBeVisible();
    const rail = page.getByRole("complementary", { name: "Mission context" });
    await expect(rail.getByText(state.seed.artifactTitle)).toBeVisible();
  });

  test("Result honestly reports completion with caveats and shows evidence", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.resultMissionId}`);
    await expect(page.getByRole("heading", { name: "Completed with caveats" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Verification" })).toBeVisible();
    // Honest: never claims a plain "Completed and verified" headline for a caveated mission.
    await expect(page.getByRole("heading", { name: "Completed and verified", exact: true })).toHaveCount(0);
  });

  test("never fabricates a numeric progress percentage", async ({ page }) => {
    await page.goto(`/app/missions/${state.seed.resultMissionId}`);
    // Honesty gate: the UI reports milestone counts, never an invented "NN%".
    await expect(page.getByText(/\b\d{1,3}\s*%/)).toHaveCount(0);
  });
});
