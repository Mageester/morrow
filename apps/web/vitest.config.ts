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
    // These suites pass comfortably on their own but sit right at the 5s
    // default when `pnpm test` runs every package's suite concurrently during
    // a release build, where jsdom rendering competes with the orchestrator
    // and CLI suites for CPU. Three of them timed out in the release gate and
    // passed standalone in the same commit, so the ceiling is contention, not
    // the assertions. apps/cli/test/bin.test.ts already carries a per-test
    // override for the same reason.
    testTimeout: 20000,
  },
});
