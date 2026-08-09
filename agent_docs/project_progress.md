# Project Progress

## Active package: RPR-3 - serialized DeepSeek flagship-web streak

**State:** active deployment package on `codex/flagship-web-v1`.

**Goal:** Extend the first verified `flagship-web-v1` DeepSeek pass into ten consecutive passes, one serialized run at a time, stopping on the first failure.

**Current evidence:** Treat [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]` and [docs/evidence/flagship-runs.jsonl](../docs/evidence/flagship-runs.jsonl) as the durable campaign record. Do not copy run counts, streak outcomes, or landed-fix lists here.

**Current state:** The baseline, completion-cleanup, and semantic rendered-evaluator packages are complete. One real `deepseek-v4-flash` web canary now passes with a completed task and artifact hash. Design `06eed01` and the streak plan govern the next serialized runs.

## Acceptance criteria

1. Run nine additional DeepSeek web canaries one at a time.
2. Require a clean preflight and append-only classification for every run.
3. Commit each evidence row before starting the next run.
4. Stop immediately on any failed, unsafe, corrupt, or unexplained result.
5. Finish with ten consecutive passing DeepSeek web rows and a qualified DeepSeek scenario result.
6. Do not invoke OpenCode Zen in this package.

## Ordered work packages

| ID | Role | Package | Dependency | Verification gate | Status |
| --- | --- | --- | --- | --- | --- |
| RPR-3.1 | main | Run and classify each remaining DeepSeek web canary | passing baseline canary | one new append-only row per invocation | in progress |
| RPR-3.2 | explorer companion | Investigate only if a run fails or classification is ambiguous | failed/ambiguous row | read-only retained evidence report | pending |
| RPR-3.3 | main | Evaluate the final DeepSeek window and select OpenCode qualification package | ten consecutive passes | scenario-aware gate result | pending |

## Constraints and parallel boundaries

- All implementation, review, integration, and live work is sequential because the runtime files and live resources overlap.
- The persistent Luna Max explorer task remains read-only and may investigate supplementary call sites.
- Workers must not edit Git state, `project_progress.md`, or `latest_session_work.md`.
- Do not weaken assertions, extend sleeps, raise timeouts, or skip tests to obtain green.
- Do not add features, UI work, or aesthetic refactors.
- Every live run must append to the existing evidence log before assertion, whether it passes or fails.

## Blockers and next action

No current blocker. Follow `docs/superpowers/plans/2026-08-09-deepseek-web-streak.md`: run one DeepSeek web canary, classify and commit its row, then decide whether the next serialized run is authorized.
