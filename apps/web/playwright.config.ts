import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL } from "./e2e/constants.js";

/**
 * Web vertical-slice E2E, accessibility, and visual-regression gates.
 *
 * The orchestrator (serving the built /app) is seeded with deterministic
 * mission state and started in global-setup, then torn down in global-teardown.
 * Tests run serially against that single stateful backend (workers=1), because
 * the journey resolves a seeded attention request that must not race.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 45_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    reducedMotion: "reduce",
    colorScheme: "light",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
