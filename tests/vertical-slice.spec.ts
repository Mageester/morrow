import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function workspace(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

test('persists verified workspace inspection across browser reload', async ({ page }) => {
  const item = workspace('morrow-e2e-');
  try {
    writeFileSync(join(item.path, 'evidence.txt'), 'Hello from E2E');
    const projectName = `E2E ${Date.now()}`;
    await page.goto('/');
    await page.screenshot({ path: '.artifacts/screenshots/empty-projects.png' });
    await page.getByRole('button', { name: /New project/i }).click();
    await page.getByLabel('Name').fill(projectName);
    await page.getByLabel('Workspace path').fill(item.path);
    await page.locator('.create-modal').getByRole('button', { name: /^Create project$/i }).click();
    await expect(page.locator('.task-panel h2')).toHaveText(projectName);
    await page.screenshot({ path: '.artifacts/screenshots/populated-projects.png' });

    await page.getByRole('button', { name: 'Inspect workspace' }).click();
    await expect(page.locator('.task-row .status-chip')).toHaveText(/Queued|Running/);
    await page.screenshot({ path: '.artifacts/screenshots/running-task.png' });
    await expect(page.locator('.event-list li').first()).toBeVisible();
    await expect(page.locator('.verification')).toBeVisible();
    await expect(page.locator('.step-list li.completed')).toHaveCount(3);
    await expect(page.locator('.evidence-list')).toContainText('evidence.txt');
    await expect(page.locator('.detail-grid')).toContainText('Deterministic local');
    await expect(page.locator('.detail-grid')).toContainText('No model invoked');
    await expect(page.locator('.event-list li').last()).toContainText('task.verified');
    await expect(page.locator('.task-row .status-chip')).toHaveText('Verified');
    await page.screenshot({ path: '.artifacts/screenshots/verified-task.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.artifacts/screenshots/mobile-verified.png' });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.reload();
    await page.locator('.project-row').filter({ hasText: projectName }).click();
    await page.locator('.task-row').filter({ hasText: 'Inspect workspace' }).click();
    await expect(page.locator('.status-overview .status-chip.verified')).toBeVisible();
    await expect(page.locator('.verification')).toBeVisible();
    await expect(page.locator('.step-list li.completed')).toHaveCount(3);
    await expect(page.locator('.evidence-list')).toContainText('evidence.txt');
    await expect(page.locator('.detail-grid')).toContainText('Network disabled');
  } finally { item.remove(); }
});

test('renders failed workspace inspection without false success', async ({ page }) => {
  const item = workspace('morrow-e2e-failure-');
  try {
    const projectName = `Failed ${Date.now()}`;
    await page.goto('/');
    await page.getByRole('button', { name: /New project/i }).click();
    await page.getByLabel('Name').fill(projectName);
    await page.getByLabel('Workspace path').fill(item.path);
    await page.locator('.create-modal').getByRole('button', { name: /^Create project$/i }).click();
    await expect(page.locator('.task-panel h2')).toHaveText(projectName);
    item.remove();

    await page.getByRole('button', { name: 'Inspect workspace' }).click();
    await expect(page.locator('.status-overview .status-chip.failed')).toBeVisible();
    await expect(page.locator('.step-list li.failed')).toHaveCount(1);
    await expect(page.getByRole('alert')).toContainText('Task failed');
    await expect(page.locator('.verification')).toHaveCount(0);
    await expect(page.locator('.evidence-list')).toHaveCount(0);
    await expect(page.locator('.event-list li').last()).toContainText('task.failed');
    await page.screenshot({ path: '.artifacts/screenshots/failed-task.png' });
  } finally { item.remove(); }
});
