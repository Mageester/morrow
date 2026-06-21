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
    await expect(page.locator('.task-item-header .task-badge')).toHaveText(/Queued|Running|Verified/);
    await expect(page.locator('.activity-item').first()).toBeVisible();
    await expect(page.locator('.verification-box.verified')).toBeVisible();
    await expect(page.locator('.plan-step.completed')).toHaveCount(3);
    await expect(page.locator('.evidence-section')).toContainText('evidence.txt');
    await expect(page.locator('.disclosure-section')).toContainText('Deterministic local');
    await expect(page.locator('.disclosure-section')).toContainText('No model invoked');
    await expect(page.locator('.activity-item:last-child')).toContainText('task.verified');

    await page.reload();
    await page.waitForFunction((name) => {
      const select = document.querySelector('#project-select') as HTMLSelectElement;
      return select && Array.from(select.options).some(opt => opt.text === name);
    }, projectName);
    await page.selectOption('#project-select', { label: projectName });
    await page.locator('.task-item').filter({ hasText: 'Inspect Workspace' }).click();
    await expect(page.locator('.task-badge.verified').first()).toBeVisible();
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
    await expect(page.locator('.task-badge.failed').first()).toBeVisible();
    await expect(page.locator('.plan-step.failed')).toHaveCount(1);
    await expect(page.getByRole('alert')).toContainText('Task failed');
    await expect(page.locator('.verification-box')).toHaveCount(0);
    await expect(page.locator('.evidence-section')).toHaveCount(0);
    await expect(page.locator('.activity-item:last-child')).toContainText('task.failed');
  } finally { item.remove(); }
});

test('agent chat workflow with tool calls, reload persistence, and cancellation', async ({ page }) => {
  const item = workspace('morrow-agent-e2e-');
  const artifactDir = 'C:/Users/aidan/.gemini/antigravity/brain/f574330a-6be0-41f1-bc0f-4447e5231622';
  try {
    // 1. Setup workspace with evidence file
    writeFileSync(join(item.path, 'evidence.txt'), 'Hello from Agent E2E');
    const projectName = `Agent E2E ${Date.now()}`;
    
    // 2. Load app and create project
    await page.goto('/');
    await page.fill('#new-project-name', projectName);
    await page.fill('#new-workspace-path', item.path);
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.locator('.workspace-header h3')).toHaveText(`${projectName} Workspace`);

    // 3. Create conversation
    await page.getByRole('button', { name: '+ New Conversation' }).click();
    await expect(page.locator('.chat-empty')).toContainText('Ask a project-related question');
    
    // Screenshot: Empty State
    await page.screenshot({ path: `${artifactDir}/screenshot_empty_state.png` });

    // 4. Send user message to start agent_chat task
    await page.locator('.composer-input').fill('Explain this repository');
    await page.locator('.composer-form button[type="submit"]').click();

    // 5. Verify user message persists
    await expect(page.locator('.message-bubble.user .msg-text')).toHaveText('Explain this repository');

    // 6. Wait for active tool call and verify in inspector
    await expect(page.locator('.tool-call-item').first()).toBeVisible();
    await expect(page.locator('.evidence-item').first()).toContainText('evidence.txt');
    
    // Screenshot: Active Tool Call
    await page.screenshot({ path: `${artifactDir}/screenshot_active_tool_call.png` });

    // 7. Wait for assistant streamed response to complete
    await expect(page.locator('.message-bubble.assistant .msg-text')).toContainText('Based on the evidence');
    await expect(page.locator('.task-badge.completed').first()).toBeVisible();

    // Screenshot: Real Streamed Response / Completed Run Inspector
    await page.screenshot({ path: `${artifactDir}/screenshot_real_streamed_response.png` });
    await page.screenshot({ path: `${artifactDir}/screenshot_completed_run_inspector.png` });

    // 8. Reload browser and select project
    await page.reload();
    await page.waitForFunction((name) => {
      const select = document.querySelector('#project-select') as HTMLSelectElement;
      return select && Array.from(select.options).some(opt => opt.text === name);
    }, projectName);
    await page.selectOption('#project-select', { label: projectName });
    
    // 9. Restore conversation and verify persistence
    await expect(page.locator('.message-bubble.user .msg-text')).toHaveText('Explain this repository');
    await expect(page.locator('.message-bubble.assistant .msg-text')).toContainText('Based on the evidence');
    
    // Screenshot: After Reload
    await page.screenshot({ path: `${artifactDir}/screenshot_after_reload.png` });

    // 10. Send follow-up message and immediately cancel
    await page.locator('.composer-input').fill('Follow-up query to cancel');
    await page.locator('.composer-form button[type="submit"]').click();
    
    // Wait for the stop button to appear and click it
    await page.locator('.stop-btn').click();

    // 11. Verify cancelled state is persisted
    await expect(page.locator('.streaming-state.cancelled')).toBeVisible();
    await expect(page.locator('.task-badge.cancelled').first()).toBeVisible();

    // Screenshot: Cancelled Run
    await page.screenshot({ path: `${artifactDir}/screenshot_cancelled_run.png` });

    // 12. Reload again to verify cancelled state remains persistent
    await page.reload();
    await page.waitForFunction((name) => {
      const select = document.querySelector('#project-select') as HTMLSelectElement;
      return select && Array.from(select.options).some(opt => opt.text === name);
    }, projectName);
    await page.selectOption('#project-select', { label: projectName });
    await expect(page.locator('.streaming-state.cancelled')).toBeVisible();
  } finally {
    item.remove();
  }
});
