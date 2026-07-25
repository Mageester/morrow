# Morrow Web App Foundation — Final Release Review

Branch: `feat/morrow-web-app-foundation` · PR #64 (draft)
Merge base: `2604256` (beta.31) · Head: `401b844`
Whole-branch package: `review-2604256..401b844-whole-branch.diff` (99 code
files, +11188/-16).

## Verification matrix (re-run at head)

| Gate | Result |
|------|--------|
| `@morrow/contracts` test | 39/39 PASS |
| `@morrow/ui` test / check / build | 14/14 PASS / PASS / PASS |
| `@morrow/web` test | 151/151 PASS |
| Repository-wide `pnpm check` | 7/7 packages PASS (+ repo validation) |
| Repository-wide `pnpm build` | 6/6 packages PASS |
| `@morrow/orchestrator` full suite | 1156/1157 (1 pre-existing flake) |
| `@morrow/cli` full suite | 732/734 (2 pre-existing, same root cause) |
| Playwright E2E (`@morrow/web` e2e) | 17/17 PASS (run 3×; fresh re-seed compares baselines) |
| `/app` static serving/routing (server-web-static) | 9/9 PASS |
| Packaging + installer contracts (node --test) | 13 pass / 0 fail / 1 skip |
| Whole-branch `git diff --check` (source) | clean (warnings only in markdown docs/evidence) |
| No browser-visible secrets (bundle scan) | clean (no keys, no `VITE_`/`process.env` inlined) |

## Pre-existing failures — distinguished by evidence (NOT branch regressions)

The only failing tests at head are long-running, load-dependent flakes that
reproduce on the base with all branch changes stashed:

- Orchestrator `sustained-autonomy` — "completes a long mission with real
  rollovers, recovery, restart, and Guardian authorization". At head this run:
  1 failure. At baseline `ebc9767` (branch changes absent), the full suite
  failed `sustained-autonomy`, `browser-injection`, `context-management`, and
  `agent-beta26-regression`; the set varies per run (e.g. `context-management`
  passes in isolation). All are timing/parallel-load sensitive.
- CLI `acceptance-durable-autonomy` (2) — wraps
  `runSustainedAutonomyAcceptance` from `@morrow/orchestrator` (the same
  sustained path) and does not import any file this branch changed. Reproduced
  identically at baseline `ebc9767`.

Branch-added tests (Task 11 static-serving 9, Task 12 E2E 17) all pass. No
branch file touches the mission-controller/Guardian, browser-automation, or
search subsystems these flakes exercise.

## Plan gate coverage

- Refresh recovery — E2E "a refresh recovers the same mission and state".
- SSE resume / ordered streaming — orchestrator `server-web-stream` (resumable,
  ordered, no-duplicate) + web `mission-stream` unit tests.
- Attention / approval flow — E2E "resolves a seeded attention request" + web
  `attention-card` unit tests (incl. remount/stale race regressions).
- Runtime outage/recovery — E2E "reports offline then recovers to online" + web
  `runtime-status` unit tests.
- No fabricated progress — E2E "never fabricates a numeric progress percentage"
  + contracts test rejecting `progressPercent`.
- No completion without evidence — projection `verification.passed` requires
  `completed` + Guardian pass + no failed criterion; Result renders honest
  `completed_with_caveats` for the seeded partial mission.
- No browser-visible secrets — bundle scan clean; projection tests exclude
  secret content.
- Keyboard-only — E2E "supports keyboard-only navigation across the mission
  tabs" + accessibility focus-trap test.
- Mobile layouts — E2E visual snapshots at 390×844 (+ tablet, desktop, dark).
- `/app` packaging & routing — `server-web-static` (redirect, SPA fallback,
  asset 404 vs HTML, `/api` untouched) + packaging contract (web/index.html
  required, provenance-covered).

## Whole-branch assessment

- Tasks 1–9 were independently reviewed during implementation (specification,
  quality, accessibility, security) — all APPROVED, zero open Critical/Important
  (see `task-*-review.md` and the ledger).
- Tasks 10–12 were independently reviewed this session over their cumulative
  ranges — all APPROVED, zero open Critical/Important. Task 10 closed six
  Important findings (incl. the attention-ordering race); Task 12's axe gate
  found and fixed one serious accessibility issue.
- Security/privacy: no secret enters browser storage or browser-visible
  payloads; `/app` is loopback-only; the release package adds the web bundle as
  a first-class surface (ADR 0007) without weakening the no-secrets / no-dev-cruft
  package contract; the CLI, installer, and orchestrator API remain backward
  compatible.

## Verdict

- Critical release blockers: 0.
- Important release blockers: 0.
- Non-blocking: markdown docs (SDD briefs' EOF blank lines; spec-doc intentional
  two-space line breaks) trip `git diff --check` — cosmetic, no code impact.
  Playwright visual baselines are Windows/Chromium-pinned. Full agent-driven
  mission completion is validated by orchestrator acceptance suites, not the
  browser gate (documented).

Every branch-scoped gate genuinely passes. The remaining suite failures are
evidenced pre-existing flakes unrelated to this branch. PR #64 is left **draft**
and is **not merged**; a maintainer should confirm the flaky sustained-autonomy
suite is acceptable (or stabilize it separately) before marking ready.
