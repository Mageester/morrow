# Ruthless Simplification Audit

Date: 2026-08-26
Scope: repository-wide review of mission, execution, persistence, verification,
provider, memory, task, tool, and UI-state paths.

This audit is intentionally evidence-led. It records where duplication was
removed and where similar-looking code remains separate because it owns a
different authority, failure contract, or security boundary.

## Findings and decisions

| Area | Evidence inspected | Decision |
| --- | --- | --- |
| Mission lifecycle | `services/orchestrator/src/mission/controller.ts` (625 lines), `controller-runner.ts` (541), `service.ts` (2,189), `runtime-state.ts` (70), and `docs/MISSIONS.md` | Keep the explicit runtime state machine and service/controller split. Terminal transitions, Guardian grading, evidence close-out, and worker recovery are separate authorities; merging them would make failed or blocked missions easier to misreport as complete. |
| Execution/runtime | `services/orchestrator/src/execution/agent.ts` (7,621 lines after this pass), the 21 execution modules, `runner.ts`, and ADR 0017 | Consolidate repeated interrupted-task persistence in the agent loop and fold duplicated agent-budget token/wall-clock checks into one resource evaluator. Keep checkpoint creation, lease fencing, provider recovery, and tool dispatch at their existing call sites because their ordering is safety-significant. |
| Persistence | `repositories/tasks.ts`, `task-records.ts`, `execution-continuity.ts`, `mission-runtime.ts`, and `conversations.ts` (1,706 lines combined) | Keep raw task/event rows, execution segments, mission runtime rows, and conversation projections distinct. They support restart recovery, lease fencing, and presentation without one table becoming the authority for another. |
| Verification/completion | `execution/completion-contract.ts`, `requirements.ts`, `checkpoint-snapshot.ts`, `progress.ts`, `progress-snapshot.ts`, plus `docs/MISSIONS.md` | Keep completion evaluation, explicit requirement evaluation, checkpoint snapshots, and progress observation separate. Each answers a different question and must not turn an observation into completion evidence. |
| Providers/model config | 35 provider modules, `provider/registry.ts` (686 lines), fallback/capability modules, routing model/preset/budget code, `docs/providers.md`, and ADRs 0010/0017 | No provider consolidation. Adapter wire behavior, exact-route capability facts, fallback eligibility, and credential/configuration boundaries are intentionally independent; a generic adapter abstraction would hide protocol-specific failure behavior. |
| Memory | `repositories/memory.ts` (501 lines), the seven Cortex modules, `docs/privacy-model.md`, and `docs/CORTEX.md` | No change. Memory scope, owner authorization, redaction, and automatic capture are privacy-sensitive boundaries; no safe duplicate was found that justified a broad refactor. |
| UI state/status | `apps/web/src/api/chat-stream.ts`, `mission-stream.ts`, their tests, and the shared event-stream implementation | Keep transport mechanics shared, but use one typed lifecycle-event callback and explicit `pause()`/`stop()` controls. Cursor validation, query reconciliation, terminal completion, and retry policy remain stream-specific. Production stream code is 440 lines now versus 450 lines before extraction. |
| Task/resume | `runner.ts`, task dispatch/continuation code, `execution-continuity.ts`, and resume tests | Keep cancellation-root tracking, descendant cancellation, continuation replay, and lease claims separate. They close different races and are not interchangeable retries. |
| Tool execution | `tools/command-executor.ts` (426 lines), `command-policy.ts` (240), `catalog.ts` (384), `diff-applier.ts` (462), `tool-argument-repair.ts` (539), and privacy/approval tests | The path-boundary duplicate was removed in the prior pass. Keep command policy, process execution, patch application, and argument repair separate: permissions must be decided before execution and patch containment must remain independent of shell handling. |

Protected prototype UI files listed by `agent_docs/project_structure.md` were
not inspected or modified.

## Implemented simplifications

1. `isAnyAbsolutePath` now has one canonical implementation in
   `workspace/path-boundary.ts`; dead local predicates and containment wrappers
   were removed from workspace readers and tool repair.
2. Mission and chat EventSource transport now share capped reconnect,
   online/offline, visibility, and cleanup mechanics. The callback surface was
   reduced from nine lifecycle hooks/guards to one typed event callback. A
   terminal stream pauses transport while its canonical queries retry.
3. The agent loop now records interrupted state, task transition, user-visible
   incomplete/paused text, and plan-step skip through one local recorder across
   no-progress, segment-budget, unattended-budget, mission-recovery,
   requirement, assigned-agent-budget, and missing-final-answer paths.
4. Current and post-turn assigned-agent budget checks share one token/wall-clock
   evaluator while preserving the intentional `>=` versus `>` boundary.

## Verification evidence

- TDD red/green: the new EventSource lifecycle test failed before the helper
  interface existed, then passed after the typed event/pause implementation.
- TDD red/green: the terminal failure test initially exposed a fake-timer test
  scheduling hang; after replacing `waitFor` with an explicit microtask flush,
  it passed and verifies terminal cursor retention, closed transport, 1s/2s
  bounded retries, offline timer cancellation, and immediate visible/online
  retries.
- Focused web stream tests: 3 files, 15 tests passed.
- Focused execution tests: 4 files, 67 tests passed.
- `pnpm --filter @morrow/web check` and
  `pnpm --filter @morrow/orchestrator check` passed.
- Package suites passed: web 67 files / 447 tests; orchestrator 245 files /
  2,625 passed / 5 skipped.
- Root `pnpm test`, `pnpm check`, and `pnpm build` passed.

No provider calls, telemetry, external inference, credentials, permissions, or
workspace scope were added. The changes are reversible by reverting the two
prior-pass commits and the follow-up commit(s) listed in the implementation
report.
