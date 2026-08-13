# Project Progress

## Active package: RPR-5 - fresh artifact recovery

**State:** paused at a verified safe boundary on `codex/flagship-web-v1`.

**Goal:** Prevent a provider's false missing-task narrative from poisoning later artifact recovery, and stop reasoning-only escalation immediately if one trusted fresh-context attempt still cannot act.

**Current evidence:** Treat [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]` and [docs/evidence/flagship-runs.jsonl](../docs/evidence/flagship-runs.jsonl) as the durable campaign record. Do not copy run counts, streak outcomes, or landed-fix lists here.

**Current state:** RPR-5 is implemented and committed at `dd15b0e`. A trusted one-shot artifact recovery now drops poisoned assistant/tool/provider-private context while preserving durable audit rows, conservatively refuses reset after a successful `run_command`, survives restart and context-segment rollover through an exact durable turn key, and interrupts immediately if the fresh response is empty or reasoning-only. Independent Luna Max review returned `APPROVED`. Main verification passed the focused file (24/24), adjacent agent/projection tests (31/31), the complete non-live orchestrator suite (175 files / 1,921 tests), and orchestrator TypeScript. The user stopped the campaign at this boundary; no post-fix live canary, corpus work, or OpenCode Zen run was started.

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
| RPR-5.2 | Luna Max implementer | Add red regression and trusted fresh-context recovery | approved plan | focused green evidence | complete |
| RPR-5.3 | independent Luna Max reviewer | Review isolation, audit preservation, restart identity, and retry termination | implementation diff | `APPROVED` after two repair rounds | complete |
| RPR-5.4 | main | Integrate and verify the full non-live suite | approved green change | commit `dd15b0e`; 175 files / 1,921 tests | complete |
| RPR-5.5 | main | Run one serialized post-fix DeepSeek canary | explicit future authorization | append-only evidence row | paused by user; not started |

## Constraints and parallel boundaries

- All implementation, review, integration, and live work is sequential because the runtime files and live resources overlap.
- The persistent Luna Max explorer task remains read-only and may investigate supplementary call sites.
- Workers must not edit Git state, `project_progress.md`, or `latest_session_work.md`.
- Do not weaken assertions, extend sleeps, raise timeouts, or skip tests to obtain green.
- Do not add features, UI work, or aesthetic refactors.
- Every live run must append to the existing evidence log before assertion, whether it passes or fails.

## Blockers and next action

The deterministic repair gate is complete, but the campaign is intentionally stopped. Do not start a live run, corpus work, OpenCode Zen qualification, or new subagent without fresh user authorization. If the campaign is resumed, the next and only action is preflight followed by one serialized DeepSeek `flagship-web-v1` canary whose result is appended unchanged to `docs/evidence/flagship-runs.jsonl`; stop again immediately on failure.
