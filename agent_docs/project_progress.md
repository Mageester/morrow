# Project Progress

## Active package: RPR-5 - fresh artifact recovery

**State:** active deployment package on `codex/flagship-web-v1`.

**Goal:** Prevent a provider's false missing-task narrative from poisoning later artifact recovery, and stop reasoning-only escalation immediately if one trusted fresh-context attempt still cannot act.

**Current evidence:** Treat [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]` and [docs/evidence/flagship-runs.jsonl](../docs/evidence/flagship-runs.jsonl) as the durable campaign record. Do not copy run counts, streak outcomes, or landed-fix lists here.

**Current state:** RPR-4 is committed and independently approved. Its authorized canary, run `5cbe11ee-3c4a-438c-a1d6-4d8ed923ece9`, truthfully failed: the prompt was durably present and uncompacted, but DeepSeek made three discovery calls, then repeatedly claimed no task existed. Morrow replayed that mistaken transcript into recovery and spent three reasoning-only retries. The failed row is committed at `8a1daf4`; no retry is authorized. `docs/superpowers/plans/2026-08-09-fresh-artifact-recovery.md` governs RPR-5.

## Acceptance criteria

1. Add a failing full-agent regression for the retained false missing-task transcript.
2. Rebuild one trusted provider request from system context plus the original request at artifact recovery.
3. Drop mistaken assistant/tool/provider-continuation history from that request while preserving durable audit rows.
4. Interrupt immediately if the fresh response is still reasoning-only/empty.
5. Obtain independent review and full deterministic verification before exactly one new canary.

## Ordered work packages

| ID | Role | Package | Dependency | Verification gate | Status |
| --- | --- | --- | --- | --- | --- |
| RPR-5.1 | explorer companion | Classify prompt continuity and retry amplification | retained failed run | read-only event/projection report | complete |
| RPR-5.2 | Luna Max implementer | Add red regression and trusted fresh-context recovery | approved plan | focused green evidence | pending |
| RPR-5.3 | independent Luna Max reviewer | Review isolation, audit preservation, and retry termination | implementation diff | approve or precise defects | pending |
| RPR-5.4 | main | Integrate, verify full non-live suite, and run one canary | approved green change | committed evidence row | pending |

## Constraints and parallel boundaries

- All implementation, review, integration, and live work is sequential because the runtime files and live resources overlap.
- The persistent Luna Max explorer task remains read-only and may investigate supplementary call sites.
- Workers must not edit Git state, `project_progress.md`, or `latest_session_work.md`.
- Do not weaken assertions, extend sleeps, raise timeouts, or skip tests to obtain green.
- Do not add features, UI work, or aesthetic refactors.
- Every live run must append to the existing evidence log before assertion, whether it passes or fails.

## Blockers and next action

Live execution is blocked by the committed failed row. Complete `docs/superpowers/plans/2026-08-09-fresh-artifact-recovery.md`; do not issue another provider call before deterministic implementation, independent review, and full verification complete.
