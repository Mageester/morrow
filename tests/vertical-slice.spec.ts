import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Full Vertical Slice: Project Creation through Verification', async ({ page }) => {
  // Setup temp workspace
  const workspacePath = mkdtempSync(join(tmpdir(), 'morrow-e2e-'));
  writeFileSync(join(workspacePath, 'evidence.txt'), 'Hello from E2E');

  await page.goto('/');

  // Create Project
  const projectName = `E2E ${Date.now()}`;
  await page.fill('input[id="new-project-name"]', projectName);
  await page.fill('input[id="new-workspace-path"]', workspacePath);
  await page.click('button:has-text("Create Project")');

  // Verify Project Selected
  await expect(page.locator('.workspace-header h3')).toContainText(projectName);

  // Start Inspection
  await page.click('button:has-text("Inspect Workspace")');

  // Verify Queueing and Execution state
  await expect(page.locator('.task-item-header .task-badge')).toContainText(/(QUEUED|RUNNING|VERIFIED)/i);

  // Wait for verification completion
  await expect(page.locator('.verification-box')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.verification-box.verified')).toBeVisible();

  // Validate Inspector Content
  await expect(page.locator('.disclosure-section')).toContainText('Deterministic local');
  await expect(page.locator('.evidence-section')).toContainText('evidence.txt');
  await expect(page.locator('.activity-item:last-child')).toContainText('task.verified');
});
