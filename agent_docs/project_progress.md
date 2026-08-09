# Project Progress

## Active package: RPR-4 - supervised-process observation progress

**State:** active deployment package on `codex/flagship-web-v1`.

**Goal:** Repair the deterministic stagnation defect exposed by the stopped DeepSeek streak: genuinely new supervised-process output must permit the next verification/cleanup turn, while repeated polling remains bounded.

**Current evidence:** Treat [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]` and [docs/evidence/flagship-runs.jsonl](../docs/evidence/flagship-runs.jsonl) as the durable campaign record. Do not copy run counts, streak outcomes, or landed-fix lists here.

**Current state:** The result-sensitive process-observation repair is committed at `4c86a7e`. New task-owned process status and previously unseen raw output byte intervals reset stagnation once; empty, repeated, overlapping, failed, offset-only, cross-task, and non-finite-offset polls do not. Independent process/tool review approved the final diff after UTF-8, memory-retention, and non-finite-offset defects were corrected. The complete non-live suite and TypeScript pass; exactly one explicit canary is now authorized.

## Acceptance criteria

1. Add a failing full-agent regression for the retained process-output interruption.
2. Count only genuinely new task-owned process status/output as one progress delta.
3. Prove unchanged and offset-only polls still stagnate.
4. Obtain independent process/tool-boundary review and run the complete non-live suite.
5. Run exactly one explicit DeepSeek web canary; only a pass authorizes a restarted streak.

## Ordered work packages

| ID | Role | Package | Dependency | Verification gate | Status |
| --- | --- | --- | --- | --- | --- |
| RPR-4.1 | explorer companion | Confirm the smallest result-sensitive progress predicate | retained failed run | read-only code/test report | complete |
| RPR-4.2 | Luna Max implementer | Add red regression and minimal accounting repair | approved plan | focused green evidence | complete |
| RPR-4.3 | independent Luna Max reviewer | Review process/tool boundary and regression strength | implementation diff | approve or precise defects | complete |
| RPR-4.4 | main | Integrate, verify full non-live suite, and run one canary | approved green change | committed evidence row | in progress |

## Constraints and parallel boundaries

- All implementation, review, integration, and live work is sequential because the runtime files and live resources overlap.
- The persistent Luna Max explorer task remains read-only and may investigate supplementary call sites.
- Workers must not edit Git state, `project_progress.md`, or `latest_session_work.md`.
- Do not weaken assertions, extend sleeps, raise timeouts, or skip tests to obtain green.
- Do not add features, UI work, or aesthetic refactors.
- Every live run must append to the existing evidence log before assertion, whether it passes or fails.

## Blockers and next action

Deterministic review and verification are complete. Run exactly one explicit `deepseek-v4-flash` `flagship-web-v1` canary, inspect and commit its append-only row, and stop immediately if it fails or is ambiguous.
