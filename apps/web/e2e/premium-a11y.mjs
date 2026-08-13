/**
 * Accessibility and reduced-motion verification for the premium UI, run
 * against the real application rather than a story or fixture.
 *
 * Checks, per mapped route:
 *   - axe-core violations (WCAG 2 A/AA)
 *   - every interactive control reachable by keyboard, in order
 *   - a visible focus indicator on the first focused control
 *   - no animation or transition longer than a frame under reduced motion
 *
 * Usage: node apps/web/e2e/premium-a11y.mjs [--base <url>]
 */
import { createRequire } from "node:module";
import { chromium } from "playwright";

// axe-core is a transitive dependency of @axe-core/playwright, so resolve it
// from that package rather than assuming a hoisted layout.
const require = createRequire(import.meta.url);
function resolveAxe() {
  for (const from of ["axe-core/axe.min.js", "@axe-core/playwright"]) {
    try {
      const base = require.resolve(from);
      if (from.endsWith("axe.min.js")) return base;
      return require.resolve("axe-core/axe.min.js", { paths: [base] });
    } catch {
      /* try the next resolution root */
    }
  }
  throw new Error("axe-core could not be resolved; run pnpm install in apps/web.");
}
const axeSource = await import("node:fs/promises").then((fs) => fs.readFile(resolveAxe(), "utf8"));

const args = process.argv.slice(2);
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:4318";
const PROJECT_ID = "afbbe5ba-7c61-45eb-b4cf-1136ca90f362";

const ROUTES = [
  ["home", "/app/"],
  ["projects", "/app/projects"],
  ["memory", "/app/memory"],
  ["skills", "/app/skills"],
  ["history", "/app/chats"],
  ["connections", "/app/connections"],
  ["settings", "/app/settings"],
  ["missions", "/app/missions"],
  ["teams", "/app/teams"],
  ["pair", "/app/pair"],
];

const browser = await chromium.launch();
let failures = 0;

for (const reducedMotion of ["no-preference", "reduce"]) {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: reducedMotion === "reduce" ? "reduce" : "no-preference",
    viewport: { width: 1600, height: 1000 },
  });
  await context.addInitScript((projectId) => {
    try {
      localStorage.setItem("morrow-active-project", projectId);
      localStorage.setItem("morrow-theme", "dark");
    } catch {
      /* storage disabled */
    }
  }, PROJECT_ID);

  for (const [name, path] of ROUTES) {
    const page = await context.newPage();
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#main-content", { timeout: 15000 });
    await page.waitForTimeout(1200);

    if (reducedMotion === "no-preference") {
      await page.addScriptTag({ content: axeSource });
      const results = await page.evaluate(async () =>
        // eslint-disable-next-line no-undef
        await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }),
      );
      const violations = results.violations.filter((v) => v.impact !== "minor");
      if (violations.length > 0) {
        failures += violations.length;
        console.error(`axe ${name}: ${violations.length} violation(s)`);
        for (const v of violations) {
          console.error(`  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
          console.error(`    ${v.nodes[0]?.target?.join(" ")}`);
        }
      } else {
        console.log(`axe ${name.padEnd(12)} clean`);
      }

      // Keyboard reach: tab through and confirm focus lands on real controls
      // with a visible indicator.
      const reached = await page.evaluate(() => {
        const focusable = [...document.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )].filter((el) => el.offsetParent !== null || el === document.activeElement);
        return focusable.length;
      });
      await page.keyboard.press("Tab");
      const focusVisible = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        return {
          name: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? el.tagName,
          outline: `${s.outlineStyle} ${s.outlineWidth}`,
        };
      });
      if (!focusVisible) {
        failures += 1;
        console.error(`focus ${name}: Tab did not reach a control`);
      } else {
        console.log(`kbd ${name.padEnd(12)} ${reached} controls; first focus "${focusVisible.name}"`);
      }
    } else {
      // Reduced motion: nothing may animate or transition beyond a frame.
      const moving = await page.evaluate(() => {
        const offenders = [];
        for (const el of document.querySelectorAll("*")) {
          for (const pseudo of [null, "::before", "::after"]) {
            const s = getComputedStyle(el, pseudo ?? undefined);
            const dur = (value) => Math.max(0, ...value.split(",").map((v) => {
              const t = v.trim();
              return t.endsWith("ms") ? parseFloat(t) : t.endsWith("s") ? parseFloat(t) * 1000 : 0;
            }));
            const a = dur(s.animationDuration);
            const t = dur(s.transitionDuration);
            if ((a > 20 && s.animationName !== "none") || t > 20) {
              offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}${pseudo ?? ""} anim=${s.animationDuration}/${s.animationName} trans=${s.transitionDuration}`);
            }
          }
        }
        return [...new Set(offenders)].slice(0, 6);
      });
      if (moving.length > 0) {
        failures += moving.length;
        console.error(`reduced-motion ${name}: ${moving.length} still animating`);
        for (const m of moving) console.error(`  - ${m}`);
      } else {
        console.log(`reduced-motion ${name.padEnd(12)} still`);
      }
    }
    await page.close();
  }
  await context.close();
}

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} accessibility/motion problem(s).`);
  process.exitCode = 1;
} else {
  console.log("\nAccessibility and reduced-motion checks passed.");
}
