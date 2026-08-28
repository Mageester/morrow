import { test, expect, type Page } from "@playwright/test";
import { loadState } from "./seed-state.js";

const state = loadState();

async function openLightRoute(
  page: Page,
  path: string,
  viewport = { width: 1600, height: 1000 },
) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.waitForTimeout(350);
}

async function resolveBackground(page: Page, token: string) {
  return page.evaluate((customProperty) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = `var(${customProperty})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}

async function backgroundStyle(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.backgroundColor} ${style.backgroundImage}`;
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((projectId) => {
    localStorage.setItem("morrow-active-project", projectId);
    localStorage.setItem("morrow-theme", "light");
    localStorage.setItem("morrow.onboarding.completed.v1", "true");
  }, state.seed.projectId);
});

test("keeps mapped workspace surfaces readable in light mode", async ({ page }) => {
  await openLightRoute(page, "/app/projects");
  const lightField = await resolveBackground(page, "--morrow-product-field");
  const lightFieldStrong = await resolveBackground(page, "--morrow-product-field-strong");
  const lightInset = await resolveBackground(page, "--morrow-product-field-inset");
  expect(await backgroundStyle(page, ".morrow-feature-panel")).toContain(lightFieldStrong);

  await openLightRoute(page, "/app/chats");
  expect(await backgroundStyle(page, '.morrow-chronicle__entry[data-featured="true"]')).toContain(lightFieldStrong);

  await openLightRoute(page, "/app/skills");
  expect(await backgroundStyle(page, '.morrow-library__row[aria-current="true"]')).toContain(lightInset);

  await openLightRoute(page, "/app/settings");
  expect(await backgroundStyle(page, ".morrow-settings-book")).toContain(lightField);

  await openLightRoute(page, "/app/connections");
  expect(await backgroundStyle(page, ".morrow-provider-catalog li")).toContain(lightFieldStrong);
});

test("stacks Memory actions without stretching controls on mobile", async ({ page }) => {
  await openLightRoute(page, "/app/memory", { width: 390, height: 844 });

  const geometry = await page.evaluate(() => {
    const toolbar = document.querySelector(".morrow-memory-commandbar");
    const learning = document.querySelector(".morrow-memory-commandbar__learning");
    const buttons = [...document.querySelectorAll(".morrow-memory-commandbar > button")];
    const rect = (element: Element | undefined) => {
      const box = element?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom } : null;
    };
    return {
      toolbar: rect(toolbar ?? undefined),
      learning: rect(learning ?? undefined),
      buttons: buttons.map((button) => rect(button)),
    };
  });

  expect(geometry.buttons).toHaveLength(2);
  const [save, exportButton] = geometry.buttons;
  expect(save).not.toBeNull();
  expect(exportButton).not.toBeNull();
  expect(save!.height).toBeLessThanOrEqual(52);
  expect(exportButton!.height).toBeLessThanOrEqual(52);
  expect(save!.width).toBeGreaterThan(250);
  expect(exportButton!.width).toBeGreaterThan(250);
  expect(save!.y).toBeGreaterThanOrEqual((geometry.learning?.bottom ?? 0) - 1);
  expect(exportButton!.y).toBeGreaterThanOrEqual(save!.bottom - 1);
});
