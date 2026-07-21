# Morrow Web App Foundation — SDD Progress Ledger

Branch: `feat/morrow-web-app-foundation` (worktree `C:\Morrow\worktrees\morrow-web-app-foundation`)
Base: `2604256` (beta.31) + docs commits `6103b5a`, `c005ce1`
Plan: `docs/superpowers/plans/2026-07-19-morrow-web-app-foundation-mission-vertical-slice.md`
Spec: `docs/superpowers/specs/2026-07-19-morrow-web-app-product-ui-design.md`
PR: #64 (draft)

## Pre-flight plan review (2026-07-19)

Verified against codebase before Task 1:

1. **Toolchain OK.** Node v24.13.1, pnpm 10.12.1 (matches packageManager). `pnpm install --frozen-lockfile` clean. Baseline `@morrow/contracts` test (36 passed) and `check` green.
2. **`packages/ui` already exists but contains only README.md.** Not in pnpm-lock as a workspace package with deps. Plan's "create package" steps valid; keep/update README.
3. **`MissionService.create` real signature is `create(projectId: string, input: CreateMissionInput)`** — not the object form sketched in plan Task 3. Plan explicitly says adapt to exact signature. `CreateMissionInput` has `objective`, `autoApprove`, `preset`, `providerId`, `model`, `reasoning`, `conversationId`, budget fields — no idempotencyKey.
4. **Missions table has NO idempotency_key column.** Tasks table does (migration 12, unique index per project). Task 3 must add a migration for missions (mirror tasks pattern) or map idempotency at web-route level. Decision recorded per-task.
5. **Mission statuses confirmed**: draft, awaiting_criteria_approval, running, reviewing, completed, completed_with_reservations, partially_completed, blocked, failed, cancelled — matches plan's `uiState` mapping exactly.
6. **Criterion states confirmed**: proposed, approved, in_progress, verified, failed, waived, unverified — matches plan's milestone mapping.
7. **Existing idempotency helper `readIdempotencyKey` already in server.ts** (header or body, 200-char bound) — reuse, don't duplicate.
8. **Existing SSE pattern** at `/api/tasks/:id/events/stream` and `parseEventCursor` in server.ts — Task 4 should follow house patterns.
9. **server.ts is 2362 lines** — web routes must be a separate plugin file (as planned), registered in `buildServer()`.
10. **Workspace globs** (`apps/*`, `services/*`, `packages/*`) already cover `apps/web`. Existing apps: cli, desktop, landing. Vitest 4.1.9, Zod 4.1.12, Fastify 5.8.5, TS 5.9.3 — plan stack matches.

No plan-blocking contradictions. Proceed to Task 1.

## Model allocation

- haiku: fully specified mechanical tasks (Task 1)
- sonnet: well-specified component work (5, 7, 9)
- opus: multi-file integration (2, 3, 4, 6, 8, 10, 11)
- fable (session model): architecture-sensitive gates (12), final whole-branch review

## Recovery checkpoint (2026-07-19)

- Existing worktree recovered at `C:\Morrow\worktrees\morrow-web-app-foundation`; no tracked or staged changes were present.
- Reviewed Tasks 1-2 checkpoint `7dba7ed` was ancestry-verified against remote base `c005ce1` and pushed to `origin/feat/morrow-web-app-foundation`.
- Task 3 commit `4674fff` and its prior independent review were recovered from local session artifacts. Verdicts: specification APPROVED, code quality APPROVED, security APPROVED; zero Critical or Important findings.
- Task 4 implementation commit `6541c1d` and review-fix commit `e499d2a` were recovered. Initial review found one Critical browser-secret exposure and two Important query/lifecycle issues. Independent re-review approved specification, quality, and security after the fixes; zero Critical or Important findings remain.
- Exact next action: push the Task 4 reviewed checkpoint and evidence, then dispatch Task 5 from `e499d2a` using the existing `packages/ui` README as the package starting point.

## Task ledger

| Task | Status | Base commit | Head commit | Tests | Spec review | Quality review |
|------|--------|------------|------------|-------|-------------|----------------|
| 1. Web contracts | done | c005ce1 | d2f5ad4 | contracts 39/39 + check | APPROVED | APPROVED (0 crit/imp; 1 minor plan-inherited, 1 nit datetime deprecation) |
| 2. Projection | done | d2f5ad4 | 7dba7ed | proj 9/9, check ok, contracts 39/39 | APPROVED | APPROVED (Important fixed in 7dba7ed; 2 nits open) |
| 3. REST endpoints | done | 7dba7ed | 4674fff | 36 focused + migration 12/12, check ok | APPROVED | APPROVED + security APPROVED (0 crit/imp; 1 minor N+1 list, 2 nits) |
| 4. SSE stream | done | 4674fff | e499d2a | stream + missions 27/27, check ok, diff-check ok | APPROVED | APPROVED + security APPROVED (0 crit/imp; 1 minor backlog pagination) |
| 5. UI package | done | ea98699 | 7e012a7 | UI 13/13, check ok, build ok, diff-check ok | APPROVED | APPROVED (3 Important fixed; 1 minor test-wiring gap) |
| 6. App scaffold | done | 6d8bd9c | 0755cb8 | web 26/26, check ok, build ok, diff-check ok, browser QA ok | APPROVED | APPROVED + accessibility/security APPROVED (4 Important fixed; 2 minor) |
| 7. Home/composer | done | a68f912 | 5232218 | web 41/41, check ok, build ok, diff-check ok | APPROVED | APPROVED + accessibility/security APPROVED (8 Important fixed; 1 privacy minor) |
| 8. Overview/activity/stream | done | 425944e | c76751c | web 56/56, check ok, build ok, diff-check ok | APPROVED | APPROVED + accessibility/security APPROVED (3 Important fixed; 0 open) |
| 9. Work/Result | done | 22a24b8 | 7fcdacf | web 118/118, UI 14/14, checks/builds ok, diff-check ok | APPROVED | APPROVED + accessibility/security APPROVED (5 Important fixed; 0 open) |
| 10. Attention/errors | done | 3bac520 | 3396792 | web 151/151 (attention-card 15/15), check ok, build ok, diff-check ok | APPROVED | APPROVED + accessibility/security/race APPROVED (6 Important fixed over 3 rounds; 0 open; 2 non-blocking minor) |
| 11. /app serving + packaging | pending | — | — | — | — | — |
| 12. E2E/a11y/visual gates | pending | — | — | — | — | — |
| Final review | pending | — | — | — | — | — |

Notes:
- 3 pre-existing orchestrator test failures on base branch (context-management.test.ts, sustained-autonomy.test.ts) — unrelated to web work, verified pre-existing via stash on 7dba7ed. Track at final gate.
- Task 3 added migration 37 (missions.idempotency_key) + updated migration-count assertions in 2 existing test files.
- Remote branch currently preserves reviewed Tasks 1-4 and durable evidence at `ea98699`; Task 5 is review-clean locally at `7e012a7` and is next to push with this ledger.
- Task 5 extended the existing `packages/ui` README/package rather than recreating it. Independent review found and fixed three Important accessibility/composition issues in `7e012a7`.
- Task 6 added the `/app/` React/Vite shell, typed API client, TanStack routes/query foundation, global theme, and runtime status boundary. Independent review found and fixed four Important quality/accessibility issues in `0755cb8`.
- Task 7 added the universal objective-first composer, honest progressive controls, project selection, idempotent mission creation, cache/navigation, and ordered Home sections. Three review rounds fixed eight Important behavior/accessibility findings.
- Task 8 added authoritative mission snapshots, resumable ordered named-event streaming, honest offline/reconnect state, accessible Overview/Activity, and stable four-tab semantics. Review fixed three Important state/accounting/ARIA issues.
- Task 9 added text-only adaptive artifact views and conservative evidence-backed Result delivery. Three review rounds fixed five Important truth, identity, keyboard, and ARIA issues.
- Task 9 and its durable evidence `3bac520` are pushed; Tasks 1-9 are review-clean on `origin/feat/morrow-web-app-foundation`.
- Task 10 added honest attention/error/runtime-reconnect/recovery surfaces on the existing web slice (no orchestrator/contract/shared-UI/packaging change). Three review rounds fixed six Important findings; the final `3396792` closed the last race finding with a durable `QueryClient`-scoped serialization coordinator and compare-and-swap cache reconciliation (`WeakMap` generation + `dataUpdateCount`, `refetchType: "none"`). Independent re-review over `3bac520..3396792`: specification/quality/accessibility/security/race all APPROVED, 0 Critical, 0 Important. Full evidence in `task-10-report.md` and `task-10-review.md`; package `review-3bac520..3396792.diff`.

## Task 10 recovery checkpoint (2026-07-21)

- Recovered the existing worktree after Codex hit its usage limit mid-gate. Local HEAD was `3396792` (3 commits ahead of remote `3bac520`, 0 behind); working tree clean; the final race fix was already committed, not dirty. Only untracked files were SDD evidence.
- Independently re-ran every Task 10 gate green (web 151/151, attention-card 15/15 incl. remount + stale-response race regressions, check, build, diff-check) and re-reviewed the cumulative range before recording completion.
- Exact next action: push Task 10 + durable evidence, post PR #64 evidence, then dispatch Task 11 (/app serving + packaging) from `3396792`.
