import { test, expect, Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function workspace(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

test.beforeEach(async ({ page }) => {
  // Ensure onboarding is completed by default for existing vertical slice tests
  await page.request.post('http://localhost:4317/api/onboarding', {
    data: { onboarded: true }
  });
});

async function createProject(page: Page, name: string, path: string) {
  await page.getByRole('button', { name: 'New Project' }).first().click();
  await page.fill('#new-project-name', name);
  await page.fill('#new-workspace-path', path);
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.locator('.workspace-header h3')).toHaveText(`${name} Workspace`);
}

async function openProjectFromList(page: Page, name: string) {
  const row = page.locator('.ptable tbody tr').filter({ hasText: name }).first();
  await expect(row).toBeVisible();
  await row.locator('.row-menu').click();
  await expect(page.locator('.workspace-header h3')).toHaveText(`${name} Workspace`);
}

test('persists a verified workspace inspection across reload', async ({ page }) => {
  const item = workspace('morrow-e2e-');
  try {
    writeFileSync(join(item.path, 'evidence.txt'), 'Hello from E2E');
    const name = `E2E ${Date.now()}`;
    await page.goto('/');
    await createProject(page, name, item.path);

    await page.getByRole('button', { name: 'Inspect workspace' }).click();
    await expect(page.locator('.insp-sub .status.verified')).toBeVisible();
    await expect(page.locator('.plan-step.completed')).toHaveCount(3);
    await expect(page.locator('.evidence-section')).toContainText('evidence.txt');
    await expect(page.locator('.disclosure-section')).toContainText('Deterministic local');
    await expect(page.locator('.disclosure-section')).toContainText('Network disabled');
    await expect(page.locator('.disclosure-section')).toContainText('No model invoked');
    await expect(page.locator('.verification-section')).toContainText('Verified');

    await page.reload();
    await page.locator('.ptable tbody tr').filter({ hasText: name }).first().click();
    await expect(page.locator('.insp-sub .status.verified')).toBeVisible();
    await expect(page.locator('.plan-step.completed')).toHaveCount(3);
    await expect(page.locator('.evidence-section')).toContainText('evidence.txt');
  } finally { item.remove(); }
});

test('renders a failed workspace inspection without false success', async ({ page }) => {
  const item = workspace('morrow-e2e-failure-');
  try {
    const name = `Failed ${Date.now()}`;
    await page.goto('/');
    await createProject(page, name, item.path);
    item.remove();

    await page.getByRole('button', { name: 'Inspect workspace' }).click();
    await expect(page.locator('.insp-sub .status.failed')).toBeVisible();
    await expect(page.locator('.plan-step.failed')).toHaveCount(1);
    await expect(page.locator('.timeline')).toContainText('Failed');
    await expect(page.locator('.evidence-section')).toHaveCount(0);
    await expect(page.locator('.verification-section')).not.toContainText('Verified');
  } finally { item.remove(); }
});

test('agent chat: tool calls, evidence, reload persistence, and cancellation', async ({ page }) => {
  const item = workspace('morrow-agent-e2e-');
  try {
    writeFileSync(join(item.path, 'evidence.txt'), 'Hello from Agent E2E');
    const name = `Agent E2E ${Date.now()}`;
    await page.goto('/');
    await createProject(page, name, item.path);

    await page.locator('.composer-input').fill('Explain this repository');
    await page.locator('.composer-form button[type="submit"]').click();
    await expect(page.locator('.message-bubble.user .msg-text')).toHaveText('Explain this repository');

    await expect(page.locator('.tools-section')).toContainText('read_file');
    await expect(page.locator('.evidence-section')).toContainText('evidence.txt');
    await expect(page.locator('.message-bubble.assistant .msg-text')).toContainText('Based on the evidence');
    await expect(page.locator('.insp-sub .status.completed')).toBeVisible();

    // Reload, reopen the conversation, verify persistence
    await page.reload();
    await openProjectFromList(page, name);
    await expect(page.locator('.message-bubble.user .msg-text')).toHaveText('Explain this repository');
    await expect(page.locator('.message-bubble.assistant .msg-text')).toContainText('Based on the evidence');

    // Follow-up then cancel
    await page.locator('.composer-input').fill('Follow-up query to cancel');
    await page.locator('.composer-form button[type="submit"]').click();
    await page.locator('.stop-btn').click();
    await expect(page.locator('.streaming-state.cancelled')).toBeVisible();

    await page.reload();
    await openProjectFromList(page, name);
    await expect(page.locator('.streaming-state.cancelled')).toBeVisible();
  } finally { item.remove(); }
});

test('onboarding E2E flow: welcomes user, configures name/usecase, lets user setup provider and workspace, then launches dashboard', async ({ page }) => {
  // Reset onboarding status to show the landing page
  await page.request.post('http://localhost:4317/api/onboarding/reset');

  await page.goto('/');

  // 1. Landing/Welcome page
  await expect(page.locator('.brand-header h2')).toHaveText('M O R R O W');
  await page.click('text=Begin Onboarding');

  // 2. Install step (Developer Preview)
  await expect(page.locator('h1')).toHaveText('Developer Preview Setup');
  await page.click('text=Next');

  // 3. Profile/Usecase step
  await expect(page.locator('h1')).toHaveText('Profile & Setup');
  await page.fill('#user-name-input', 'Aidan E2E');
  await page.selectOption('#user-usecase-select', 'Software Development');
  await page.click('text=Next');

  // 4. Provider step
  await expect(page.locator('h1')).toHaveText('Provider Credentials');
  await page.click('text=Next');

  // 5. Autonomy/Mode step
  await expect(page.locator('h1')).toHaveText('Autonomy & Security');
  await page.click('text=Next');

  // 6. Workspace step (Register Project)
  await expect(page.locator('h1')).toHaveText('Register Workspace');
  
  const item = workspace('morrow-e2e-onboard-');
  try {
    await page.fill('input[placeholder="My Project"]', 'E2E Onboard Project');
    await page.fill('input[placeholder="C:\\\\Users\\\\aidan\\\\projects\\\\code"]', item.path);
    await page.click('button:has-text("Register Workspace")');
    await expect(page.locator('.badge-ok')).toBeVisible();
    await page.click('text=Next');

    // 7. Skills step
    await expect(page.locator('h1')).toHaveText('Local Skills Toggles');
    await page.click('text=Next');

    // 8. Complete step
    await expect(page.locator('h2')).toHaveText('Setup Complete');
    await page.click('text=Launch Workspace Dashboard');

    // Should redirect to Workspace Dashboard
    await expect(page.locator('.workspace-header h3')).toHaveText('E2E Onboard Project Workspace');
  } finally {
    item.remove();
  }
});
