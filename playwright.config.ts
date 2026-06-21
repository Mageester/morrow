import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const databasePath = join(mkdtempSync(join(tmpdir(), 'morrow-playwright-')), 'morrow.db');

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @morrow/orchestrator start',
      port: 4317,
      reuseExistingServer: false,
      env: { ...process.env, DATABASE_URL: databasePath, MOCK_PROVIDER: 'true' },
    },
    {
      command: 'pnpm --filter @morrow/web dev',
      port: 5173,
      reuseExistingServer: false,
    }
  ],
});
