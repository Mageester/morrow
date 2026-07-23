// Ad-hoc layout acceptance for the chat-first shell. Drives the LIVE dev server
// across the directive's width matrix, asserts no horizontal overflow and no
// sidebar/main overlap, and captures screenshots for manual review.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.MORROW_BASE ?? "http://localhost:4318";
const PROJECT = "4777d47f-7436-4518-b70d-026cf1974af6";
const CONVO = "cd560069-6244-4f5a-9291-c227dba84ef6";
const URL = `${BASE}/app/chats/${CONVO}?projectId=${PROJECT}`;
const OUT = "docs/redesign/slice8-acceptance/layout";
mkdirSync(OUT, { recursive: true });

const WIDTHS = [1920, 1600, 1440, 1280, 1024, 900, 768, 430, 390, 360];
const SHOT_WIDTHS = new Set([1440, 1280, 768, 390]);
const THEMES = ["dark", "light"];

const browser = await chromium.launch();
const failures = [];
for (const theme of THEMES) {
  const context = await browser.newContext({ colorScheme: theme });
  const page = await context.newPage();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    // Rest at the bottom of the thread — the natural chat state, where the
    // pinned composer sits below the last message rather than over mid-thread.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const box = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, w: r.width }; };
      const side = box(".morrow-sidebar");
      const main = box(".morrow-main");
      const desktop = window.innerWidth > 760;
      // Desktop: no sidebar descendant may escape the sidebar's right edge (the
      // floating-badge bug). Mobile turns the sidebar into a horizontally
      // scrollable bottom bar, where child overflow is intentional, so skip it.
      let spill = 0;
      if (side && desktop) for (const el of document.querySelectorAll(".morrow-sidebar *")) { spill = Math.max(spill, el.getBoundingClientRect().right - side.right); }
      // user bubbles within viewport
      let userOverflow = 0;
      for (const el of document.querySelectorAll(".morrow-conversation-message--user")) { userOverflow = Math.max(userOverflow, el.getBoundingClientRect().right - window.innerWidth); }
      // Mobile: the closed drawer must sit off-screen (not cover content), and
      // the composer must stay within the viewport.
      let drawerOnScreen = 0;
      let composerOverflow = 0;
      if (!desktop && side) drawerOnScreen = Math.round(side.right); // ~0 when translated off-screen
      const composerEl = document.querySelector(".morrow-chat-composer");
      if (composerEl) composerOverflow = Math.round(composerEl.getBoundingClientRect().right - window.innerWidth);
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, overflowX: de.scrollWidth - de.clientWidth, side, main, spill: Math.round(spill), userOverflow: Math.round(userOverflow), drawerOnScreen, composerOverflow };
    });
    const problems = [];
    if (m.overflowX > 1) problems.push(`overflowX=${m.overflowX}`);
    if (m.spill > 1) problems.push(`sidebar spill=${m.spill}px`);
    if (m.userOverflow > 1) problems.push(`user bubble past viewport=${m.userOverflow}px`);
    if (m.composerOverflow > 1) problems.push(`composer past viewport=${m.composerOverflow}px`);
    if (width <= 760 && m.drawerOnScreen > 1) problems.push(`closed drawer on-screen (right=${m.drawerOnScreen})`);
    // sidebar/main overlap (desktop only: mobile stacks nav to the bottom)
    if (width > 760 && m.side && m.main && m.main.x < m.side.right - 1) problems.push(`main under sidebar (main.x=${Math.round(m.main.x)} < side.right=${Math.round(m.side.right)})`);
    const tag = `${theme} ${width}`.padEnd(12);
    if (problems.length) { failures.push(`${tag} ${problems.join(", ")}`); console.log(`FAIL ${tag} ${problems.join(", ")}`); }
    else console.log(`ok   ${tag} overflowX=${m.overflowX} spill=${m.spill}`);
    if (SHOT_WIDTHS.has(width)) await page.screenshot({ path: `${OUT}/chat-${theme}-${width}.png`, fullPage: false });
  }
  await context.close();
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILURES` : "\nALL PASS");
process.exit(failures.length ? 1 : 0);
