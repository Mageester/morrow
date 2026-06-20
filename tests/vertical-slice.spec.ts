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
    await page.fill('#new-project-name', projectName);
    await page.fill('#new-workspace-path', item.path);
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.locator('.workspace-header h3')).toHaveText(`${projectName} Workspace`);

    await page.getByRole('button', { name: 'Inspect Workspace' }).click();
    await expect(page.locator('.task-item-header .task-badge')).toHaveText(/Queued|Running/);
    await expect(page.locator('.activity-item').first()).toBeVisible();
    await expect(page.locator('.verification-box.verified')).toBeVisible();
    await expect(page.locator('.plan-step.completed')).toHaveCount(3);
    await expect(page.locator('.evidence-section')).toContainText('evidence.txt');
    await expect(page.locator('.disclosure-section')).toContainText('Deterministic local');
    await expect(page.locator('.disclosure-section')).toContainText('No model invoked');
    await expect(page.locator('.activity-item:last-child')).toContainText('task.verified');

    await page.reload();
    await page.selectOption('#project-select', { label: projectName });
    await page.locator('.task-item').filter({ hasText: 'Inspect Workspace' }).click();
    await expect(page.locator('.task-badge.verified')).toBeVisible();
    await expect(page.locator('.verification-box.verified')).toBeVisible();
    await expect(page.locator('.plan-step.completed')).toHaveCount(3);
    await expect(page.locator('.evidence-section')).toContainText('evidence.txt');
    await expect(page.locator('.disclosure-section')).toContainText('Network disabled');
  } finally { item.remove(); }
});

test('renders failed workspace inspection without false success', async ({ page }) => {
  const item = workspace('morrow-e2e-failure-');
  try {
    const projectName = `Failed ${Date.now()}`;
    await page.goto('/');
    await page.fill('#new-project-name', projectName);
    await page.fill('#new-workspace-path', item.path);
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.locator('.workspace-header h3')).toHaveText(`${projectName} Workspace`);
    item.remove();

    await page.getByRole('button', { name: 'Inspect Workspace' }).click();
    await expect(page.locator('.task-badge.failed')).toBeVisible();
    await expect(page.locator('.plan-step.failed')).toHaveCount(1);
    await expect(page.getByRole('alert')).toContainText('Task failed');
    await expect(page.locator('.verification-box')).toHaveCount(0);
    await expect(page.locator('.evidence-section')).toHaveCount(0);
    await expect(page.locator('.activity-item:last-child')).toContainText('task.failed');
  } finally { item.remove(); }
});
