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
7. Build and deterministic unit tests pass without invoking a real provider.
8. No real-provider streak is run in this session.
9. The protected prototype UI surfaces remain untouched.

## Ordered work packages

| ID | Role | Package | Dependency | Verification gate | Status |
| --- | --- | --- | --- | --- | --- |
| FWV1-0 | main | Bootstrap verified project documentation and implementation design | none | bounded source/doc inspection | in progress |
| FWV1-1 | executor_luna | Generalize flagship gate per scenario using TDD | FWV1-0 | focused red/green unit test and relevant regression | pending |
| FWV1-2 | executor_luna | Add flagship-web-v1 harness scenario and harness-owned verification using TDD | FWV1-1 | focused deterministic scenario tests and relevant regression | pending |
| FWV1-3 | tester | Independently verify behavior, boundary coverage, and non-live isolation | FWV1-2 | focused tests, orchestrator suite, typecheck/build as applicable | pending |
| FWV1-4 | reviewer | Review critical diffs, all boundary implementations, and protected scope | FWV1-3 | clean spec and quality verdict | pending |
| FWV1-5 | main | Reconcile durable documentation and next-session live-run handoff | FWV1-4 | links and status consistency | pending |

## Constraints and parallel boundaries

- Production implementation is sequential because the gate and scenario share acceptance types and tests.
- The persistent explorer remains read-only and may investigate supplementary call sites.
- Workers must not edit Git state, `project_progress.md`, or `latest_session_work.md`.
- Do not weaken assertions, extend sleeps, raise timeouts, or skip tests to obtain green.
- Do not add features, UI work, or aesthetic refactors.
- Do not run live providers. The next session will run streaks in Medium route, one at a time.

## Blockers and next action

The runtime's fixed Luna explorer model was unavailable, so the explorer companion is transparently running on Terra with the same read-only contract. Production executor availability will be checked when implementation begins; no silent role substitution is allowed.

Next: finish bounded interface discovery, write and review the approved design and implementation plan, then start FWV1-1 with a failing gate test.

