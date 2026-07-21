# Task 12 Independent Review

Base: `50c5ddf` (Task 11 durable evidence head).

Head: `48822b9` (`test(web): add E2E, accessibility, and visual gates for the vertical slice`).

Reviewed range: `50c5ddf..48822b9` (1 commit, 20 files, +607/-2 plus 4 baseline
PNGs). Package: `review-50c5ddf..48822b9.diff` (source excludes the binaries).

## Specification compliance — APPROVED (with a documented, user-approved boundary)

The plan's Task 12 required an isolated deterministic-provider fixture and a
browser journey covering creation, activity, refresh recovery, reconnect,
attention resolution, artifact inspection, Result verification, keyboard
navigation, plus accessibility and responsive/visual gates.

Delivered and verified green (17/17, twice, second run comparing baselines):
- deterministic isolated backend (temp home, mock provider, loopback), seeded
  through the orchestrator's own repositories/service;
- creation → durable workspace, ≥1 activity item, refresh recovery, offline →
  online reconnect, attention resolution (recommendation never auto-selected),
  artifact inspection, honest caveated Result with evidence, keyboard-only tab
  nav, and a no-fabricated-percent honesty gate;
- axe scans (zero serious/critical) on Home + attention + Result, and
  destructive-dialog focus trap/restoration;
- responsive + dark visual snapshots.

Boundary (explicitly chosen by the requester and documented in the report and
`docs/ACCEPTANCE.md`): full agent-driven mission *completion* (running →
verified) is not re-driven through the browser, because the mock provider does
not progress missions past `draft` headlessly; it is covered by the
orchestrator acceptance suites. The seeded `completed_with_caveats` mission
exercises the Result/verification/artifact rendering deterministically and
honestly.

## Code quality — APPROVED

- The seed reuses `MissionService`/repositories (single source of truth) rather
  than hand-rolled SQL for mission state; only the durable-approval seam uses
  two direct inserts, matching the pattern already in
  `server-web-missions.test.ts`.
- Global setup/teardown are robust: health-gated startup, process-tree kill,
  temp cleanup, state persisted to a gitignored file.
- Serial, `workers=1`, `retries=0` correctly model a single stateful backend
  where the attention resolution mutates shared state; file ordering keeps the
  destructive-dialog test before the consuming resolution.

## Accessibility — APPROVED (a real finding fixed)

The gate found and the change fixes a genuine serious `aria-prohibited-attr`
violation (`aria-label` on two `paragraph`-role elements). Post-fix, all three
axe scans are clean, and destructive-dialog focus management is asserted end to
end. The fix is minimal and correct (`role="status"` for the live region;
self-descriptive content for the milestone count).

## Security & privacy — APPROVED

- Loopback-only, mock-provider, private temp home; no credential, external
  network, remote, deploy, or purchase.
- `e2e-seed.ts` is a test-only `scripts/` artifact, excluded from the release
  package by the existing `dist/scripts` filter and forbidden-content contract —
  no production surface added.
- No production orchestrator path changed; the only shipped source change is the
  two web accessibility fixes.

## Honesty — APPROVED

Determinism is proven by a second, fresh-re-seed run that compares against
committed baselines rather than regenerating them. The suite actively asserts
the app never shows a fabricated numeric percent and never overclaims
"Completed and verified" for a caveated mission.

## Final verdict

- Critical: 0.
- Important: 0 open (1 serious accessibility issue was found by the gate and
  fixed in the same commit).
- Minor (non-blocking, not fixed): (1) `global-setup` spawns via `shell: true`
  (Node DEP0190) — arguments are static and controlled, so there is no injection
  surface; (2) visual baselines are Windows/Chromium-pinned (documented; a
  cross-platform CI would regenerate per platform).

## Assessment

Task quality: APPROVED. Task 12 is review-clean with zero open Critical or
Important findings; every gate genuinely passes twice, including a fresh
baseline comparison.
