# Project Progress

## Active package: FWV1 - flagship-web-v1

**State:** active deployment package on `codex/flagship-web-v1`.

**Goal:** Add a second real-provider scenario, `flagship-web-v1`, that builds a small multi-file frontend, starts a development server, verifies the served page through the real browser boundary, and runs a test command. Preserve `flagship-build-v1`.

**Current evidence:** Treat [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]` and [docs/evidence/flagship-runs.jsonl](../docs/evidence/flagship-runs.jsonl) as the durable campaign record. Do not copy run counts, streak outcomes, or landed-fix lists here.

**Known gap:** The current real-provider scenario is a small single-file CLI build. It does not exercise development-server startup, browser verification, or mission verification. Recent deterministic fixes in those boundaries therefore lack real-run coverage. A separate open defect remains in `buildProviderProjection`: `_morrowAppliedWrite` can be projected as a re-emittable write tool call.

## Acceptance criteria

1. Generalize `flagship-gate.ts` to score supported scenarios independently; unknown scenarios remain excluded.
2. Prove gate generalization with a deterministic unit test before adding the new scenario.
3. Add `flagship-web-v1` in the existing harness without replacing `flagship-build-v1`.
4. The scenario requires a small multi-file frontend, a supervised development server, a browser check against the served page, and a test command.
5. The pass/fail checker is owned by the harness and never exposed to the model.
6. Scoring semantics remain equivalent across supported flagship scenarios.
7. A control run proves the existing live path before the new scenario is introduced.
8. Build, typecheck, and deterministic tests pass before live web validation.
9. Run real providers serially: stop at the first failure, diagnose and fix the owning boundary with a deterministic regression, then resume the same task.
10. Reach ten consecutive DeepSeek passes before beginning OpenCode Zen.
11. The protected prototype UI surfaces remain untouched.

## Ordered work packages

| ID | Role | Package | Dependency | Verification gate | Status |
| --- | --- | --- | --- | --- | --- |
| FWV1-0 | main | Bootstrap verified project documentation and implementation design | none | bounded source/doc inspection | completed |
| FWV1-1 | main | Generalize flagship gate per scenario using TDD | FWV1-0 | focused red/green unit test and relevant regression | completed |
| FWV1-2 | main | Add flagship-web-v1 harness scenario and harness-owned verification using TDD | FWV1-1 | focused deterministic scenario tests and relevant regression | completed |
| FWV1-3 | main | Verify deterministic behavior and repository compatibility | FWV1-2 | focused tests, full orchestrator suite, typecheck, build | completed |
| FWV1-4 | main | Run serialized DeepSeek evidence streak and stop on first failure | FWV1-3 | append-only evidence plus failure diagnosis | in progress |
| FWV1-5 | main | Run serialized OpenCode Zen evidence streak | FWV1-4 | append-only evidence | pending |
| FWV1-6 | main | Reconcile durable documentation and session handoff | FWV1-5 | links and status consistency | pending |

## Constraints and parallel boundaries

- All remaining work is sequential because live runs share ports, SQLite state, and temporary workspaces.
- The persistent explorer remains read-only and may investigate supplementary call sites.
- Workers must not edit Git state, `project_progress.md`, or `latest_session_work.md`.
- Do not weaken assertions, extend sleeps, raise timeouts, or skip tests to obtain green.
- Do not add features, UI work, or aesthetic refactors.
- Every live run must append to the existing evidence log before assertion, whether it passes or fails.

## Blockers and next action

No current blocker. The first live web run exposed a completion-contract defect: Morrow requested a tool-free summary while an explicitly required task-owned server was still running. The owning completion boundary now models that cleanup obligation; focused regressions, the full orchestrator suite, repository typecheck, and build are green.

Next: commit the completion-boundary regression fix and append-only evidence, then rerun the same DeepSeek `flagship-web-v1` task definition once. Stop immediately on any failure before another attempt.
