# Task 12 Report — E2E, Accessibility, Visual, Reconnect, Recovery, and Honesty Gates

## Scope

A deterministic Playwright gate for the local `/app` product surface, plus the
accessibility fix it surfaced and acceptance documentation. No provider,
network, or agent execution is involved; every state is seeded directly.

## Determinism (user-directed)

The mock provider leaves missions in `draft` headlessly, so mission state is
seeded via `services/orchestrator/scripts/e2e-seed.ts` through the same
repositories/service the orchestrator uses, before the server opens the
database:

- **Attention mission** — a durable pending approval (task + `approvals` row)
  projects to a resolvable attention request with `approve`/`deny` choices.
- **Result mission** — `addCriterion` → `approveCriteria` (running) → evidence
  with an `artifactPath` (status `passed`) → criterion `verified` → `finalize`.
  The requirement-ledger gate honestly downgrades completion to
  `partially_completed`, projecting as `completed_with_caveats` /
  `passed_with_caveats` with one artifact and one evidence item.

`global-setup` starts an isolated orchestrator (temp `MORROW_HOME`,
`MOCK_PROVIDER`, `MORROW_DISABLE_SCHEDULER`, loopback only) serving the built
`/app` from the seeded database; `global-teardown` kills the process tree and
removes the temp home/workspace.

## Coverage

`mission-vertical-slice.spec.ts` (9):
- objective-first composer + exact approved navigation; no task-type selector;
- UI mission creation → `/app/missions/:id` with a durable, human-readable
  activity item;
- refresh recovers the same mission and state;
- offline → online runtime reconnection status;
- resolving a real attention request — recommendation shown, never
  auto-selected — that then reports "No attention is needed right now.";
- inspecting the seeded artifact through the Work tab;
- honest Result: "Completed with caveats" + evidence, never "Completed and
  verified"; a no-fabricated-percent honesty assertion;
- keyboard-only tab navigation (Arrow/Home/End roving tabindex).

`accessibility.spec.ts` (4):
- axe (`wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`) on Home, the attention mission,
  and the Result mission — zero serious/critical;
- destructive attention-dialog focus trap (`alertdialog`, focus starts on
  Cancel) and focus restoration to the invoking choice on Escape.

`visual-regression.spec.ts` (4):
- responsive (desktop 1440×1000, tablet 900×1100, mobile 390×844) and dark-mode
  snapshots of the fully-seeded mission (fixed timestamps → stable).

## Accessibility fix (surfaced by the gate)

The axe gate caught a real serious violation — `aria-prohibited-attr`: two
paragraphs used `aria-label` (prohibited on the `paragraph` role):
- `mission-page.tsx` mission-updates live region → now `role="status"` (a live
  region that permits a name), keeping the "Mission updates" label;
- `mission-overview.tsx` milestone-count paragraph → `aria-label` removed; its
  self-descriptive text ("N completed · M remaining · …") is the accessible
  name.

After the fix all three axe scans report zero serious/critical violations.

## Verification

```text
pnpm --filter @morrow/web test         PASS — 11 files, 151 tests
pnpm --filter @morrow/web check        PASS (tsc)
pnpm --filter @morrow/web build        PASS (Vite; dist served at /app)
pnpm --filter @morrow/orchestrator check PASS  (includes e2e-seed.ts)
pnpm --filter @morrow/orchestrator build PASS
pnpm --filter @morrow/web e2e:update   PASS — 17/17 (baselines generated)
pnpm --filter @morrow/web e2e          PASS — 17/17 (fresh re-seed; snapshots
                                        genuinely compared, not regenerated)
git diff --check 50c5ddf..HEAD         clean
```

The second `e2e` run re-seeds a fresh database and compares against the
committed baselines, so the green is a genuine regression comparison, not a
self-referential baseline write.

## Security & privacy

- The E2E backend is loopback-only, mock-provider, with a private temporary
  `MORROW_HOME`; no provider credential, external network call, remote, deploy,
  or purchase is involved.
- `e2e-seed.ts` is a test-only script under `scripts/` — excluded from the
  release package (`dist/scripts` is filtered out and forbidden by the package
  contract), so it adds no production surface.
- No production orchestrator code path was changed by Task 12 (the only source
  change is the two accessibility fixes in the web app).

## Boundary (documented, honest)

- Full agent-driven mission *completion* (running → verified) is not re-driven
  through the browser because the mock provider does not progress missions past
  `draft` headlessly; that path is covered by the orchestrator's own acceptance
  suites (e.g. sustained-autonomy). The browser gate instead drives the honest
  seeded states end to end.
- Visual baselines are Windows/Chromium-pinned; regenerate with `e2e:update`
  on the target platform when the design intentionally changes.

## Rollback

Revert `test(web): add E2E, accessibility, and visual gates for the vertical
slice`. This removes the Playwright suite, the seed script, the config/scripts,
and the two accessibility fixes. No durable data, contract, packaging, or
mission behavior is affected.
