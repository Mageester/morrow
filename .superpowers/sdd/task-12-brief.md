### Task 12: E2E, Accessibility, Visual, Reconnect, Recovery, and Honesty Gates

Base: `50c5ddf` (Task 11 durable evidence head).

**Goal:** a deterministic Playwright gate for the local `/app` product surface —
end-to-end journey, accessibility, responsive/visual, reconnect, recovery, and
honesty — plus acceptance documentation.

**Determinism strategy (user-directed "full determinism invest"):** the mock
provider stalls missions at `draft` headlessly, so mission state is *seeded*
directly through the orchestrator repositories/service
(`services/orchestrator/scripts/e2e-seed.ts`) rather than driven by an agent.
Two deterministic missions are seeded:
- an attention mission with a durable pending approval (a resolvable attention
  request), and
- a result mission with a persisted artifact and criterion evidence that
  finalizes to an honest `completed_with_caveats` (`passed_with_caveats`).

**Files:**
- `apps/web/playwright.config.ts` — serial, workers=1, reduced motion, global
  setup/teardown, baseURL from `e2e/constants.ts`.
- `apps/web/e2e/global-setup.ts` — temp `MORROW_HOME`, run the seed, start an
  isolated orchestrator serving the built `/app`, health-gate, persist IDs.
- `apps/web/e2e/global-teardown.ts` — kill the process tree, clean up.
- `apps/web/e2e/{constants,seed-state}.ts` — shared config + state loader.
- `apps/web/e2e/mission-vertical-slice.spec.ts` — journey + reconnect + keyboard
  + honesty.
- `apps/web/e2e/accessibility.spec.ts` — axe scans + destructive-dialog focus.
- `apps/web/e2e/visual-regression.spec.ts` — responsive + dark snapshots.
- `services/orchestrator/scripts/e2e-seed.ts` — deterministic seeder.
- `apps/web/vitest.config.ts` — exclude `e2e/` from vitest.
- `apps/web/package.json` — `e2e`/`e2e:update` scripts + `@playwright/test`,
  `@axe-core/playwright`.
- `docs/ACCEPTANCE.md` — web vertical-slice gate.

**Scope boundary (documented):** full agent-driven mission *completion*
(running → verified) is covered by the orchestrator acceptance suites, not
re-driven through the browser, because the mock provider does not progress
missions past `draft` headlessly. Visual baselines are Windows/Chromium-pinned.
