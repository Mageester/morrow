import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const referenceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(referenceDir, "..", "..", "..");
const webRoot = join(repoRoot, "apps", "web");
const { chromium } = require(require.resolve("@playwright/test", { paths: [webRoot] }));

const shotsDir = join(referenceDir, "shots");
await mkdir(shotsDir, { recursive: true });

const source = pathToFileURL(join(referenceDir, "index.html"));
const viewports = {
  desktop: { width: 1600, height: 1000 },
  mobile: { width: 390, height: 844 },
};
const captures = [
  ["home-desktop", "home", "desktop"],
  ["chat-desktop", "chat", "desktop"],
  ["projects-desktop", "projects", "desktop"],
  ["memory-desktop", "memory", "desktop"],
  ["skills-desktop", "skills", "desktop"],
  ["history-desktop", "history", "desktop"],
  ["connections-desktop", "connections", "desktop"],
  ["settings-desktop", "settings", "desktop"],
  ["home-mobile", "home", "mobile"],
  ["chat-mobile", "chat", "mobile"],
];

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [name, screen, viewportName] of captures) {
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

    const url = new URL(source);
    url.searchParams.set("screen", screen);
    await page.goto(url.href, { waitUntil: "load" });
    await page.waitForTimeout(80);
    const layout = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      title: document.title,
      bodyTextLength: document.body.innerText.length,
    }));
    const screenshot = `shots/${name}.png`;
    await page.screenshot({ path: join(referenceDir, screenshot), fullPage: false });
    results.push({ name, screen, viewport: viewportName, dimensions: viewports[viewportName], screenshot, consoleErrors, pageErrors, layout });
    await context.close();
  }
} finally {
  await browser.close();
}

const manifest = {
  generatedAt: new Date().toISOString(),
  source: "index.html?screen=<screen>",
  sourceOfTruth: ["screenshots", "index.html", "reference.css", "reference.js"],
  viewports,
  results,
};
await writeFile(join(shotsDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const failures = results.filter((result) =>
  result.consoleErrors.length || result.pageErrors.length || result.layout.horizontalOverflow || result.layout.bodyTextLength < 50,
);
console.log(`Captured ${results.length} premium UI references in ${shotsDir}`);
if (failures.length) {
  console.error(`Reference validation failed: ${failures.map((failure) => failure.name).join(", ")}`);
  process.exitCode = 1;
}
