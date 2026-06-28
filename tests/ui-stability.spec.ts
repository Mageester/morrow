import { test, expect, Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// These tests lock in the UI-stability fixes: the mobile navigation drawer must
// be reachable, modals must not trap content on short viewports, and core
// navigation must not emit console errors or unhandled promise rejections.

test.beforeEach(async ({ page }) => {
  await page.request.post('http://localhost:4317/api/onboarding', { data: { onboarded: true } });
});

function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + String(e)));
  return problems;
}

test('no console errors or unhandled rejections on load and core navigation', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  for (const label of ['Skills', 'Agents', 'Runs', 'Mission Control', 'Settings']) {
    await page.locator('.nav-item').filter({ hasText: label }).first().click();
    await page.waitForTimeout(250);
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

test('cancelling a run does not emit a console error (empty-body parse regression)', async ({ page }) => {
  const problems = collectProblems(page);
  const dir = mkdtempSync(join(tmpdir(), 'morrow-cancel-'));
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'New Project' }).first().click();
    await page.fill('#new-project-name', `Cancel ${Date.now()}`);
    await page.fill('#new-workspace-path', dir);
    await page.getByRole('button', { name: 'Create Project' }).click();

    await page.locator('.composer-input').fill('Run something I will cancel');
    await page.locator('.composer-form button[type="submit"]').click();
    // Stop the run — the cancel endpoint replies 204; the client must not choke
    // on the empty body (previously logged "Unexpected end of JSON input").
    await page.locator('.stop-btn').click();
    await expect(page.locator('.streaming-state.cancelled')).toBeVisible();

    const jsonErrors = problems.filter((p) => /Unexpected end of JSON input|JSON/i.test(p));
    expect(jsonErrors, jsonErrors.join('\n')).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slash-command palette opens, predicts, applies a mode, and dismisses', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('/');
  await page.locator('.nav-item').filter({ hasText: 'New Chat' }).first().click();
  const composer = page.locator('.composer-input');
  await expect(composer).toBeVisible();

  // Typing "/" opens the palette with grouped commands.
  await composer.click();
  await composer.fill('/');
  await expect(page.locator('.slash-menu')).toBeVisible();
  expect(await page.locator('.slash-item').count()).toBeGreaterThan(0);

  // Predictive filtering narrows as you type.
  await composer.fill('/plan');
  await expect(page.locator('.slash-item.active')).toContainText('/plan');
  // Enter applies the command (does not send a message) and shows a mode chip.
  await composer.press('Enter');
  await expect(page.locator('.composer-chip')).toContainText('Plan-only');
  expect(await composer.inputValue()).toBe('');

  // Skills are offered (bundled skill registry, lazy-loaded on first palette use).
  await composer.fill('/skill');
  await expect.poll(() => page.locator('.slash-item .slash-cmd').count()).toBeGreaterThan(0);
  await expect(page.locator('.slash-item').first()).toContainText('/skill');

  // Escape closes the palette without sending.
  await composer.fill('/model');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await composer.press('Escape');
  await expect(page.locator('.slash-menu')).toBeHidden();

  expect(problems, problems.join('\n')).toEqual([]);
});

test('survives a mid-session reload without runtime errors', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('/');
  await page.locator('.nav-item').filter({ hasText: 'Settings' }).first().click();
  await page.reload();
  await expect(page.locator('.sidebar')).toBeVisible();
  expect(problems, problems.join('\n')).toEqual([]);
});

test('inner panels scroll instead of overflowing the viewport (trapped-scroll regression)', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 560 }); // short enough to force overflow
  await page.goto('/');
  await page.locator('.nav-item').filter({ hasText: 'Settings' }).first().click();

  // The .content grid cell must stay bounded to the viewport; previously it
  // defaulted to min-height:auto and grew past 100dvh, so inner overflow-y:auto
  // panels never scrolled and their content was clipped by overflow:hidden.
  const content = page.locator('.content');
  const metrics = await content.evaluate((el) => ({
    clientH: el.clientHeight,
    win: window.innerHeight,
  }));
  expect(metrics.clientH).toBeLessThanOrEqual(metrics.win + 1);

  // The settings panel must be a real scroll container and actually move.
  const settings = page.locator('.settings');
  const moved = await settings.evaluate((el) => {
    if (el.scrollHeight <= el.clientHeight + 2) return null; // not overflowing; nothing to prove
    const before = el.scrollTop;
    el.scrollTop = 99999;
    return el.scrollTop > before;
  });
  // Either it wasn't tall enough to overflow (null) or it scrolled — never stuck.
  expect(moved === null || moved === true).toBe(true);
});

test('modals are scroll-bounded so they cannot trap content off-screen', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 360 }); // deliberately short
  await page.goto('/');
  await page.getByRole('button', { name: 'New Project' }).first().click();
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  const box = await modal.boundingBox();
  expect(box).not.toBeNull();
  // The modal must never start above the top of the viewport (the old failure:
  // a centered modal taller than the window had a negative top and was
  // unreachable). And it must be its own scroll container.
  expect(box!.y).toBeGreaterThanOrEqual(0);
  const overflowY = await modal.evaluate((el) => getComputedStyle(el).overflowY);
  const maxHeight = await modal.evaluate((el) => getComputedStyle(el).maxHeight);
  expect(overflowY).toBe('auto');
  expect(maxHeight).not.toBe('none');
});

test.describe('narrow / mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('navigation drawer is reachable, navigates, and dismisses', async ({ page }) => {
    const problems = collectProblems(page);
    await page.goto('/');

    const toggle = page.locator('.nav-toggle');
    await expect(toggle).toBeVisible();
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).not.toHaveClass(/\bopen\b/);

    // Open the drawer.
    await toggle.click();
    await expect(sidebar).toHaveClass(/\bopen\b/);
    await expect(page.locator('.sidebar-backdrop')).toBeVisible();
    // Auto-retries until the slide-in transition settles and the drawer is
    // (almost) fully on-screen, rather than sampling mid-animation.
    await expect(sidebar).toBeInViewport({ ratio: 0.95 });

    // Selecting a destination navigates AND closes the drawer.
    await page.locator('.sidebar .nav-item').filter({ hasText: 'Skills' }).first().click();
    await expect(sidebar).not.toHaveClass(/\bopen\b/);

    // Reopen, then dismiss by tapping the backdrop.
    await toggle.click();
    await expect(sidebar).toHaveClass(/\bopen\b/);
    await page.locator('.sidebar-backdrop').click({ position: { x: 360, y: 400 } });
    await expect(sidebar).not.toHaveClass(/\bopen\b/);

    expect(problems, problems.join('\n')).toEqual([]);
  });
});
