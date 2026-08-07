import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    // The same contention ceiling apps/web/vitest.config.ts already documents,
    // and this is the suite it bites hardest. These are integration tests, not
    // unit tests: they launch real Chromium, bind real HTTP servers, open real
    // SQLite databases, and apply real patches. Individually they finish in
    // well under a second to a few seconds; run four-wide on a loaded machine
    // they do not.
    //
    // The failure mode is what makes this worth configuring rather than
    // tolerating: the suite fails *non-deterministically*, and on a different
    // set of files each time. Two observed runs on identical code failed
    // agent-browser/agent-loop/context-budget and then
    // agent-beta26-regression/agent-browser/reasoning-pipeline — every one of
    // them "Test timed out in 5000ms", none of them an assertion. A red suite
    // that means "the machine was busy" trains everyone to re-run instead of
    // read it, which is how a real regression gets waved through.
    //
    // 30s is far above what any of these need when they are not starved, so it
    // still catches a genuine hang. Tests with legitimately long work
    // (sustained autonomy, the live flagship canary) set their own higher
    // timeout explicitly and are unaffected.
    testTimeout: 30_000,
    // Setup/teardown does the same real I/O — opening databases, and removing
    // temp workspace trees with retries — so it needs the same headroom.
    hookTimeout: 30_000,
  },
});
