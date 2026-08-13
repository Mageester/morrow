/**
 * Production route capture for the premium UI implementation.
 *
 * Renders the real application (Vite dev server proxying the local
 * orchestrator) at the reference viewports and writes one PNG per route, so
 * production screenshots can be compared directly against
 * docs/redesign/premium-reference/shots/*.png.
 *
 * Usage:
 *   node apps/web/e2e/capture-premium.mjs [--out <dir>] [--base <url>]
 *
 * Exits nonzero on page errors, console errors, or horizontal overflow, which
 * are the failure modes a still image hides.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const BASE = flag("base", "http://127.0.0.1:4318");
const OUT = flag("out", "output/premium-ui/shots");
const PROJECT_ID = flag("project", "afbbe5ba-7c61-45eb-b4cf-1136ca90f362");
const CONVERSATION_ID = flag("conversation", "");

const DESKTOP = { width: 1600, height: 1000 };
const MOBILE = { width: 390, height: 844 };

/** Console noise that is environmental, not a defect in the page. */
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Failed to load resource/i,
];

async function resolveConversation() {
  if (CONVERSATION_ID) return CONVERSATION_ID;
  const response = await fetch(
    `${BASE}/api/projects/${PROJECT_ID}/conversations?includeArchived=false`,
  );
  if (!response.ok) return "";
  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? rows[0].id : "";
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const conversationId = await resolveConversation();

  const routes = [
    { name: "home", path: "/app/", viewports: ["desktop", "mobile"] },
    { name: "projects", path: "/app/projects", viewports: ["desktop"] },
    { name: "memory", path: "/app/memory", viewports: ["desktop"] },
    { name: "skills", path: "/app/skills", viewports: ["desktop"] },
    { name: "history", path: "/app/chats", viewports: ["desktop"] },
    { name: "connections", path: "/app/connections", viewports: ["desktop"] },
    { name: "settings", path: "/app/settings", viewports: ["desktop"] },
  ];
  if (conversationId) {
    routes.splice(1, 0, {
      name: "chat",
      path: `/app/chats/${conversationId}?projectId=${PROJECT_ID}`,
      viewports: ["desktop", "mobile"],
    });
  }

  const browser = await chromium.launch();
  const problems = [];
  const manifest = [];

  for (const route of routes) {
    for (const kind of route.viewports) {
      const viewport = kind === "mobile" ? MOBILE : DESKTOP;
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        colorScheme: "dark",
      });
      await context.addInitScript(
        ([projectId]) => {
          try {
            localStorage.setItem("morrow-active-project", projectId);
            localStorage.setItem("morrow-theme", "dark");
            // Suppress the first-run overlay so mapped routes render their
            // real content rather than onboarding.
            localStorage.setItem("morrow.onboarding.completed.v1", "true");
          } catch {
            /* storage disabled — the route still renders */
          }
        },
        [PROJECT_ID],
      );
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
        consoleErrors.push(text);
      });
      page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

      // `networkidle` never settles: the app holds long-lived event streams
      // open by design. Wait for the shell, then for the route's own heading.
      await page.goto(`${BASE}${route.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#main-content", { timeout: 15000 });
      await page
        .waitForFunction(
          () => !document.body.textContent?.includes("Getting your workspace ready…"),
          { timeout: 10000 },
        )
        .catch(() => undefined);
      // Settle route transition and any streaming status text.
      await page.waitForTimeout(1400);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1) {
        problems.push(`${route.name} ${kind}: horizontal overflow of ${overflow}px`);
      }
      for (const error of consoleErrors) {
        problems.push(`${route.name} ${kind}: console ${error}`);
      }

      const file = `${OUT}/${route.name}-${kind}.png`;
      await page.screenshot({ path: file });
      manifest.push({ route: route.name, viewport: kind, file, overflow, consoleErrors });
      await context.close();
    }
  }

  await browser.close();
  await writeFile(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const entry of manifest) {
    console.log(`${entry.route.padEnd(12)} ${entry.viewport.padEnd(8)} ${entry.file}`);
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

await main();
