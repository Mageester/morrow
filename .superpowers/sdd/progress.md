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
| 5. UI package | pending | — | — | — | — | — |
| 6. App scaffold | pending | — | — | — | — | — |
| 7. Home/composer | pending | — | — | — | — | — |
| 8. Overview/activity/stream | pending | — | — | — | — | — |
| 9. Work/Result | pending | — | — | — | — | — |
| 10. Attention/errors | pending | — | — | — | — | — |
| 11. /app serving + packaging | pending | — | — | — | — | — |
| 12. E2E/a11y/visual gates | pending | — | — | — | — | — |
| Final review | pending | — | — | — | — | — |

Notes:
- 3 pre-existing orchestrator test failures on base branch (context-management.test.ts, sustained-autonomy.test.ts) — unrelated to web work, verified pre-existing via stash on 7dba7ed. Track at final gate.
- Task 3 added migration 37 (missions.idempotency_key) + updated migration-count assertions in 2 existing test files.
- Remote branch currently preserves reviewed Tasks 1-3 at `4674fff`; Task 4 is review-clean locally at `e499d2a` and is next to push with this ledger.
