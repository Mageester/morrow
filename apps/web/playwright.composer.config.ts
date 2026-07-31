import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  testMatch: /composer\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4381",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm.cmd exec vite --host 127.0.0.1 --port 4381 --strictPort",
    cwd: webRoot,
    reuseExistingServer: false,
    url: "http://127.0.0.1:4381/app/e2e/composer-harness.html",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-chromium",
      use: {
        browserName: "chromium",
        deviceScaleFactor: 2.75,
        hasTouch: true,
        isMobile: true,
        userAgent: "Mozilla/5.0 (Linux; Android 15; Morrow Mobile Test) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
