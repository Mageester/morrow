# Project Progress

## Active package: RPR-0 - reliability baseline and DeepSeek canary

**State:** active deployment package on `codex/flagship-web-v1`.

**Goal:** Integrate the two runtime fixes demonstrated by recent failed chats, independently calibrate the committed `flagship-web-v1` evaluator, and record one correctly classified DeepSeek `deepseek-v4-flash` canary before beginning a streak.

**Current evidence:** Treat [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]` and [docs/evidence/flagship-runs.jsonl](../docs/evidence/flagship-runs.jsonl) as the durable campaign record. Do not copy run counts, streak outcomes, or landed-fix lists here.

**Current state:** FWV1-0 through FWV1-3 are complete. Four live web rows remain non-passing. The latest historical row predates the committed supervised-process predicate. Four uncommitted runtime/test files contain the cached-observation and compaction-headroom fixes from two subsequently diagnosed chat failures. Design `06eed01` and plan `8b7e169` govern the new campaign.

## Acceptance criteria

1. Preserve and independently review the four existing runtime/test changes.
2. Retain red evidence for cached observations and compaction headroom; focused and adjacent deterministic gates pass.
3. TypeScript, the full orchestrator suite, and `git diff --check` pass after the runtime fixes.
4. An independent evaluator review proves direct and package-script supervised servers, inspection, browser use, cleanup, append ordering, and failure scoring.
5. Exactly one live DeepSeek `deepseek-v4-flash` web canary runs after deterministic gates.
6. The canary appends exactly one redacted evidence row before any assertion.
7. A failure stops the campaign and becomes one bounded deterministic repair package; a pass advances to the streak plan.
8. No OpenCode run begins in this package.

## Ordered work packages

| ID | Role | Package | Dependency | Verification gate | Status |
| --- | --- | --- | --- | --- | --- |
| RPR-0.1 | Luna Max implementer | Audit and verify cached-observation and compaction-headroom fixes | approved plan | focused, adjacent, typecheck, full orchestrator, diff check | in progress |
| RPR-0.2 | Luna Max tester/reviewer | Independently review Task 1 and calibrate flagship evaluator | RPR-0.1 | diff review plus focused evaluator gate | pending |
| RPR-0.3 | main | Integrate accepted fixes as a focused commit | RPR-0.2 | exact scope and clean staged diff | pending |
| RPR-0.4 | main | Run one DeepSeek flagship-web canary and classify it | RPR-0.3 | exactly one append-only live row | pending |
| RPR-0.5 | main | Reconcile package evidence and select pass/streak or failure/repair path | RPR-0.4 | design taxonomy and evidence consistency | pending |

## Constraints and parallel boundaries

- All implementation, review, integration, and live work is sequential because the runtime files and live resources overlap.
- The persistent Luna Max explorer task remains read-only and may investigate supplementary call sites.
- Workers must not edit Git state, `project_progress.md`, or `latest_session_work.md`.
- Do not weaken assertions, extend sleeps, raise timeouts, or skip tests to obtain green.
- Do not add features, UI work, or aesthetic refactors.
- Every live run must append to the existing evidence log before assertion, whether it passes or fails.

## Blockers and next action

No current blocker. Dispatch RPR-0.1 to one Luna Max implementation task. Do not run a provider until the independent RPR-0.2 verdict and main integration commit are complete.
