import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Unit/component tests live under src/. The Playwright E2E suite in e2e/ is
    // run by `pnpm e2e`, not vitest — exclude it so vitest never tries to load
    // @playwright/test specs.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
