import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const prototypeDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(prototypeDir, "..", "..", "..");
const webRoot = join(repoRoot, "apps", "web");
const { chromium } = require(require.resolve("@playwright/test", { paths: [webRoot] }));
const { AxeBuilder } = require(require.resolve("@axe-core/playwright", { paths: [webRoot] }));

const outputDir = join(prototypeDir, "shots", "final");
await mkdir(outputDir, { recursive: true });

const sourceUrl = process.env.MORROW_PROTOTYPE_URL
  ?? pathToFileURL(join(prototypeDir, "morrow.html")).href;
const sourceLabel = process.env.MORROW_PROTOTYPE_URL ?? "morrow.html";

const viewports = {
  desktop: { width: 1600, height: 1000 },
  tablet: { width: 1024, height: 900 },
  mobile: { width: 390, height: 844 },
};

const captures = [
  ["home-desktop-light", "home", "light", "desktop"],
  ["home-keyboard-focus-desktop-light", "home", "light", "desktop", "keep-focus"],
  ["home-desktop-dark", "home", "dark", "desktop"],
  ["chat-normal-desktop-light", "chat", "light", "desktop"],
  ["chat-active-mission-desktop-light", "mission", "light", "desktop"],
  ["chat-active-mission-desktop-dark", "mission", "dark", "desktop"],
  ["chat-approval-desktop-light", "approval", "light", "desktop"],
  ["chat-recovery-desktop-light", "recovery", "light", "desktop"],
  ["chat-recovery-desktop-dark", "recovery", "dark", "desktop"],
  ["chat-completed-result-desktop-light", "result", "light", "desktop"],
  ["project-desktop-light", "projects", "light", "desktop"],
  ["missions-desktop-light", "missions", "light", "desktop"],
  ["memory-desktop-light", "memory", "light", "desktop"],
  ["memory-desktop-dark", "memory", "dark", "desktop"],
  ["library-desktop-light", "library", "light", "desktop"],
  ["connections-desktop-light", "connections", "light", "desktop"],
  ["connections-desktop-dark", "connections", "dark", "desktop"],
  ["settings-desktop-light", "settings", "light", "desktop"],
  ["home-tablet-light", "home", "light", "tablet"],
  ["chat-active-mission-tablet-light", "mission", "light", "tablet"],
  ["home-mobile-light", "home", "light", "mobile"],
  ["chat-active-mission-mobile-light", "mission", "light", "mobile"],
  ["chat-mission-detail-mobile-light", "mission", "light", "mobile", "open-panel"],
  ["chat-approval-mobile-light", "approval", "light", "mobile"],
  ["memory-mobile-light", "memory", "light", "mobile"],
  ["memory-mobile-dark", "memory", "dark", "mobile"],
];

const browser = await chromium.launch({ headless: true });
const results = [];

try {
  for (const [name, screen, theme, viewportName, action] of captures) {
    const context = await browser.newContext({
      viewport: viewports[viewportName],
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const url = new URL(sourceUrl);
    url.searchParams.set("screen", screen);
    url.searchParams.set("theme", theme);
    await page.goto(url.href, { waitUntil: "load" });
    await page.waitForTimeout(80);

    if (action === "open-panel") {
      await page.getByRole("button", { name: "View details" }).click();
    }

    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      const style = active ? getComputedStyle(active) : null;
      return {
        tag: active?.tagName ?? null,
        label: active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? null,
        outlineStyle: style?.outlineStyle ?? null,
        outlineWidth: style?.outlineWidth ?? null,
      };
    });

    const layout = await page.evaluate((mobile) => {
      const root = document.documentElement;
      const targetSelectors = mobile
        ? [".mobile-tabs a", ".send", ".mode button", ".model-chip", ".topbar .iconbtn"]
        : [];
      const smallTargets = targetSelectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)]
          .filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { selector, text: element.textContent?.trim() ?? "", width: rect.width, height: rect.height };
          })
          .filter((target) => target.width < 44 || target.height < 44),
      );
      return {
        horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
        smallTargets,
        mobileNavigationVisible: mobile
          ? getComputedStyle(document.querySelector(".mobile-tabs")).display !== "none"
          : null,
      };
    }, viewportName === "mobile");

    const axe = await new AxeBuilder({ page }).analyze();
    if (action !== "keep-focus") {
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
    }
    const screenshotPath = join(outputDir, `${name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    results.push({
      name,
      screen,
      theme,
      viewport: viewportName,
      screenshot: `shots/final/${name}.png`,
      consoleErrors,
      pageErrors,
      focus,
      layout,
      accessibilityViolations: axe.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        description: violation.description,
        nodes: violation.nodes.length,
        evidence: violation.nodes.map((node) => ({
          target: node.target,
          html: node.html,
          failureSummary: node.failureSummary,
        })),
      })),
    });
    await context.close();
  }
} finally {
  await browser.close();
}

const reportPath = join(outputDir, "validation-report.json");
await writeFile(
  reportPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), source: sourceLabel, viewports, results }, null, 2)}\n`,
  "utf8",
);

const failures = results.filter((result) =>
  result.consoleErrors.length
  || result.pageErrors.length
  || result.layout.horizontalOverflow
  || result.layout.smallTargets.length
  || result.accessibilityViolations.length,
);

console.log(`Captured ${results.length} prototype states in ${outputDir}`);
console.log(`Validation report: ${reportPath}`);
if (failures.length) {
  console.error(`Validation issues remain in: ${failures.map((result) => result.name).join(", ")}`);
  process.exitCode = 1;
}
