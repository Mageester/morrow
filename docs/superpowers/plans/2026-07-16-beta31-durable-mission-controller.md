# Beta.31 Durable Mission Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an orchestrator-owned mission continue across model turns, context segments, task failures, CLI exits, and process restarts until Guardian-proven completion or a precise terminal disposition.

**Architecture:** Add an additive mission-runtime/operation ledger with fenced controller leases. Extract reusable agent-task dispatch from the HTTP route, let a durable controller select and execute one idempotent mission action at a time, and make task final answers return control to that controller. Reuse the existing mission contract, requirement ledger, task runner, execution segments, checkpoints, providers, approvals, and evidence stores.

**Tech Stack:** TypeScript, Zod contracts, SQLite/better-sqlite3 migrations, Fastify, Vitest, existing Morrow task/mission repositories and packaged CLI.

## Global Constraints

- Start from `e050f00` and preserve the acceptance foundation.
- No one-hour timeout or arbitrary mission turn/segment terminal condition.
- A provider response or completed worker task cannot directly complete a mission.
- Every controller transition and replayable side effect is durable and idempotent.
- Unknown or ambiguous tool effects pause for evidence or approval; they are not replayed blindly.
- Preserve local-first behavior, provider choice, credential redaction, and visible permission boundaries.
- Use deterministic providers and fixtures for development; real-model proof remains a later release gate.
- Keep each committed slice green with its focused tests.

---

## File structure

- `packages/contracts/src/mission-runtime.ts`: focused Zod schemas and pure runtime transition types.
- `packages/contracts/src/index.ts`: re-export runtime contracts; retain compatibility mission projections.
- `services/orchestrator/src/mission/runtime-state.ts`: legal transition table and deterministic next-action types.
- `services/orchestrator/src/repositories/mission-runtime.ts`: runtime, transition, operation, progress, and recovery persistence.
- `services/orchestrator/src/mission/task-dispatcher.ts`: reusable idempotent creation of a mission-linked agent task.
- `services/orchestrator/src/mission/controller.ts`: one-tick durable controller decision/dispatch engine.
- `services/orchestrator/src/mission/controller-runner.ts`: fenced in-process scheduling, wakeup, and startup reconciliation.
- `services/orchestrator/src/mission/guardian.ts`: evidence contract and terminal-disposition gate.
- `services/orchestrator/src/execution/progress.ts`: evidence-aware progress observations and exhaustion assessment.
- Existing `agent.ts`, `runner.ts`, `recovery.ts`, `server.ts`, and CLI lifecycle files integrate those units without absorbing their logic.

---

### Task 1: Runtime contracts and legal state machine

**Files:**
- Create: `packages/contracts/src/mission-runtime.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `services/orchestrator/src/mission/runtime-state.ts`
- Test: `services/orchestrator/test/mission-runtime-state.test.ts`
- Test: `services/orchestrator/test/contracts.test.ts`

**Interfaces:**
- Produces: `MissionRuntimeState`, `MissionRuntime`, `MissionRuntimeTransition`, `MissionOperation`, `MissionProgressObservation`, `MissionRecoveryDecision`, `assertMissionRuntimeTransition(from, to)`.
- Consumes: existing `MissionStatus`, requirement-node IDs, task IDs, and evidence IDs as opaque references.

- [ ] **Step 1: Write failing contract and transition tests**

```ts
it("does not let a provider or worker declare durable completion", () => {
  expect(() => assertMissionRuntimeTransition("executing", "completed", "worker_completed")).toThrow(/Guardian/i);
  expect(() => assertMissionRuntimeTransition("validating", "completed", "guardian_passed")).not.toThrow();
});

it("accepts structured durable runtime records", () => {
  const parsed = MissionRuntimeSchema.parse(runtimeFixture());
  expect(parsed.state).toBe("executing");
  expect(parsed.finalDisposition).toBeNull();
});
```

- [ ] **Step 2: Run tests and verify the missing-module failure**

Run: `pnpm --filter @morrow/orchestrator test -- mission-runtime-state.test.ts contracts.test.ts`

Expected: FAIL because `mission-runtime.ts` and `runtime-state.ts` do not exist.

- [ ] **Step 3: Implement the runtime schemas and transition table**

Use these exact states:

```ts
export const MissionRuntimeStateSchema = z.enum([
  "created", "orienting", "planning", "executing", "validating",
  "waiting_for_tool", "waiting_for_approval", "recovering", "replanning",
  "blocked", "completed", "cancelled", "abandoned", "superseded",
]);

export const MISSION_RUNTIME_TERMINAL_STATES = [
  "blocked", "completed", "cancelled", "abandoned", "superseded",
] as const;
```

`assertMissionRuntimeTransition` must reject terminal-state exits and require cause `guardian_passed` for `validating -> completed`.

- [ ] **Step 4: Run focused tests and verify PASS**

Run: `pnpm --filter @morrow/orchestrator test -- mission-runtime-state.test.ts contracts.test.ts`

Expected: both files pass.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/contracts/src/mission-runtime.ts packages/contracts/src/index.ts services/orchestrator/src/mission/runtime-state.ts services/orchestrator/test/mission-runtime-state.test.ts services/orchestrator/test/contracts.test.ts
git commit -m "feat(orchestrator): define durable mission runtime"
```

### Task 2: Atomic runtime, transition, and operation ledger

**Files:**
- Modify: `services/orchestrator/src/database.ts`
- Create: `services/orchestrator/src/repositories/mission-runtime.ts`
- Test: `services/orchestrator/test/database.test.ts`
- Create: `services/orchestrator/test/mission-runtime-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 runtime schemas and `assertMissionRuntimeTransition`.
- Produces: `missionRuntimeRepository(db)` with `create`, `get`, `transition`, `claimLease`, `renewLease`, `releaseLease`, `enqueueOperation`, `startOperation`, `completeOperation`, `failOperation`, `listOperations`, `appendProgress`, and `recordRecovery`.

- [ ] **Step 1: Write failing migration and repository tests**

```ts
it("atomically records state and its append-only transition", () => {
  const repo = missionRuntimeRepository(db);
  repo.create(runtimeInput("mission-1", now));
  repo.transition({ missionId: "mission-1", from: "created", to: "orienting", cause: "controller_started", actor: "controller", now });
  expect(repo.get("mission-1")?.state).toBe("orienting");
  expect(repo.listTransitions("mission-1")).toHaveLength(1);
});

it("deduplicates an operation by mission and idempotency key", () => {
  const first = repo.enqueueOperation(operationInput("dispatch:requirement-1"));
  const second = repo.enqueueOperation(operationInput("dispatch:requirement-1"));
  expect(second.id).toBe(first.id);
});
```

- [ ] **Step 2: Run and verify failure before migration 33 exists**

Run: `pnpm --filter @morrow/orchestrator test -- database.test.ts mission-runtime-repository.test.ts`

Expected: FAIL with missing tables/import.

- [ ] **Step 3: Add migration 33**

Create additive tables `mission_runtime`, `mission_runtime_transitions`, `mission_operations`, `mission_progress`, and `mission_recovery_decisions`. Add unique indexes on `(mission_id, sequence)` and `(mission_id, idempotency_key)`. Store structured payloads as validated JSON and include controller lease owner/generation/expiry on `mission_runtime`.

- [ ] **Step 4: Implement fenced repository transactions**

Lease claims use compare-and-swap semantics:

```sql
UPDATE mission_runtime
SET lease_owner=?, lease_generation=lease_generation+1, lease_expires_at=?, updated_at=?
WHERE mission_id=? AND state NOT IN ('blocked','completed','cancelled','abandoned','superseded')
  AND (lease_owner IS NULL OR lease_expires_at < ?)
```

Operation start/complete/fail writes must require the current lease owner and generation. `completeOperation` is idempotent only when the stored result is deeply equal.

- [ ] **Step 5: Run focused tests and verify PASS**

Run: `pnpm --filter @morrow/orchestrator test -- database.test.ts mission-runtime-repository.test.ts`

- [ ] **Step 6: Commit**

```powershell
git add -- services/orchestrator/src/database.ts services/orchestrator/src/repositories/mission-runtime.ts services/orchestrator/test/database.test.ts services/orchestrator/test/mission-runtime-repository.test.ts
git commit -m "feat(orchestrator): persist mission runtime operations"
```

### Task 3: Reusable idempotent agent-task dispatch

**Files:**
- Create: `services/orchestrator/src/mission/task-dispatcher.ts`
- Modify: `services/orchestrator/src/server.ts`
- Test: `services/orchestrator/test/api.test.ts`
- Create: `services/orchestrator/test/mission-task-dispatcher.test.ts`

**Interfaces:**
- Consumes: project/conversation/task/message/routing repositories, `TaskRunner`, and an `AgentTaskRequest` containing mission ID, content, routing, worktree, and idempotency key.
- Produces: `dispatchAgentTask(deps, request): { task, userMessage, assistantMessage, routing, replayed }`.

- [ ] **Step 1: Write a failing dispatcher idempotency test**

```ts
const one = dispatchAgentTask(deps, request({ idempotencyKey: "mission:m1:op:o1" }));
const two = dispatchAgentTask(deps, request({ idempotencyKey: "mission:m1:op:o1" }));
expect(two.replayed).toBe(true);
expect(two.task.id).toBe(one.task.id);
expect(runner.run).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run and verify missing dispatcher failure**

Run: `pnpm --filter @morrow/orchestrator test -- mission-task-dispatcher.test.ts api.test.ts`

- [ ] **Step 3: Extract dispatch without changing HTTP behavior**

Move project/mission validation, routing and reasoning validation, idempotent task creation, message creation, routing persistence, and `runner.run` behind the dispatcher. The HTTP route parses the request and converts dispatcher errors to existing `ApiError` codes.

- [ ] **Step 4: Run dispatcher and API tests**

Run: `pnpm --filter @morrow/orchestrator test -- mission-task-dispatcher.test.ts api.test.ts reasoning-pipeline.test.ts idempotency-api.test.ts`

Expected: PASS with the existing API response shape unchanged.

- [ ] **Step 5: Commit**

```powershell
git add -- services/orchestrator/src/mission/task-dispatcher.ts services/orchestrator/src/server.ts services/orchestrator/test/mission-task-dispatcher.test.ts services/orchestrator/test/api.test.ts
git commit -m "refactor(orchestrator): share agent task dispatch"
```

### Task 4: Evidence-aware progress and recovery decisions

**Files:**
- Create: `services/orchestrator/src/execution/progress.ts`
- Modify: `services/orchestrator/src/execution/adaptive-budget.ts`
- Modify: `services/orchestrator/src/mission/failures.ts`
- Create: `services/orchestrator/test/progress-assessment.test.ts`
- Modify: `services/orchestrator/test/adaptive-budget.test.ts`
- Modify: `services/orchestrator/test/recovery.test.ts`

**Interfaces:**
- Produces: `assessProgress(previous, current): MissionProgressObservation[]`, `assessExhaustion(history): ExhaustionAssessment`, and expanded `planRecovery(category, history)` returning an executable distinct-strategy decision.

- [ ] **Step 1: Write failing tests for legitimate non-file progress**

```ts
it.each(["evidence_gained", "uncertainty_reduced", "hypothesis_eliminated", "strategy_changed", "checkpoint_created", "criterion_validated"])(
  "%s prevents stagnation", kind => {
    expect(assessExhaustion([observation(kind)])).toMatchObject({ exhausted: false });
  },
);

it("requires diagnosis and a distinct remaining strategy before abandonment", () => {
  expect(assessExhaustion(repeatedSameStrategy)).toMatchObject({ exhausted: false, next: "focused_diagnosis" });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @morrow/orchestrator test -- progress-assessment.test.ts adaptive-budget.test.ts recovery.test.ts`

- [ ] **Step 3: Implement evidence-delta progress**

Do not use response text length as durable progress. Keep tool-call duplicate detection as a signal, but emit categorized observations with evidence refs and strategy fingerprints. Expand failure categories to the Beta.31 contract and ensure the next decision never repeats the same failed strategy fingerprint.

- [ ] **Step 4: Run focused tests and verify PASS**

Run: `pnpm --filter @morrow/orchestrator test -- progress-assessment.test.ts adaptive-budget.test.ts recovery.test.ts retry.test.ts loop-detector.test.ts`

- [ ] **Step 5: Commit**

```powershell
git add -- services/orchestrator/src/execution/progress.ts services/orchestrator/src/execution/adaptive-budget.ts services/orchestrator/src/mission/failures.ts services/orchestrator/test/progress-assessment.test.ts services/orchestrator/test/adaptive-budget.test.ts services/orchestrator/test/recovery.test.ts
git commit -m "feat(orchestrator): assess evidence-backed progress"
```

### Task 5: Guardian completion contract

**Files:**
- Create: `services/orchestrator/src/mission/guardian.ts`
- Modify: `services/orchestrator/src/mission/service.ts`
- Create: `services/orchestrator/test/mission-guardian.test.ts`
- Modify: `services/orchestrator/test/mission-service.test.ts`
- Modify: `services/orchestrator/test/agent-completion-gate.test.ts`

**Interfaces:**
- Consumes: mission, requirement nodes, criteria, evidence, operations, task states, approvals, canonical answer, Git diff/protected-path evidence.
- Produces: `evaluateGuardian(input): GuardianDecision` with `passed`, `missing`, `failed`, `blocked`, and `evidenceSnapshot`; `MissionService.finalize` requires a passing decision supplied by the controller.

- [ ] **Step 1: Write a failing premature-completion test**

```ts
it("rejects a final-looking provider answer and returns required next actions", () => {
  const decision = evaluateGuardian(fixture({ canonicalAnswer: "Done", criteria: [unverifiedCriterion] }));
  expect(decision.passed).toBe(false);
  expect(decision.missing).toContainEqual(expect.objectContaining({ criterionId: unverifiedCriterion.id }));
  expect(decision.nextActions).toContain("validate_criteria");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @morrow/orchestrator test -- mission-guardian.test.ts mission-service.test.ts agent-completion-gate.test.ts`

- [ ] **Step 3: Implement the pure Guardian and service gate**

`MissionService.finalize` must refuse `completed` unless the decision proves every authoritative criterion, resolved operation, closed approval, required validation class, canonical answer, and diff/protected-path check. It may still persist non-success dispositions with complete evidence.

- [ ] **Step 4: Run focused tests and verify PASS**

Run: `pnpm --filter @morrow/orchestrator test -- mission-guardian.test.ts mission-service.test.ts mission-kernel.test.ts canonical-completion-invariants.test.ts agent-completion-gate.test.ts`

- [ ] **Step 5: Commit**

```powershell
git add -- services/orchestrator/src/mission/guardian.ts services/orchestrator/src/mission/service.ts services/orchestrator/test/mission-guardian.test.ts services/orchestrator/test/mission-service.test.ts services/orchestrator/test/agent-completion-gate.test.ts
git commit -m "feat(orchestrator): gate completion through Guardian"
```

### Task 6: One-tick durable mission controller

**Files:**
- Create: `services/orchestrator/src/mission/controller.ts`
- Create: `services/orchestrator/test/mission-controller.test.ts`
- Modify: `services/orchestrator/src/mission/service.ts`

**Interfaces:**
- Consumes: runtime repository, mission service, task dispatcher, Guardian, task/approval/continuity repositories, and progress/recovery assessors.
- Produces: `MissionController.tick(missionId, lease): Promise<ControllerTickResult>` and `wakeReasonForTask(taskId)`.

- [ ] **Step 1: Write table-driven failing controller tests**

Cover these exact cases:

```ts
it.each([
  ["created", "orienting"],
  ["orienting", "planning"],
  ["planning", "executing"],
  ["worker completed without evidence", "validating"],
  ["validation failed", "recovering"],
  ["recovery selected", "replanning"],
  ["Guardian passed", "completed"],
])("advances %s to %s", async (_case, expected) => {
  expect((await controller.tick(missionId, lease)).runtime.state).toBe(expected);
});
```

Also prove a failed provider turn creates a recovery operation, a completed dispatch is not duplicated on a second tick, and an open approval enters `waiting_for_approval` without user prompting when policy allows auto-resolution.

- [ ] **Step 2: Run and verify missing controller failure**

Run: `pnpm --filter @morrow/orchestrator test -- mission-controller.test.ts`

- [ ] **Step 3: Implement one durable decision per tick**

Each tick:

1. validates the fenced lease;
2. loads mission/runtime/operations/tasks/approvals/evidence;
3. reconciles any operation whose effect already exists;
4. persists one transition or operation before dispatching a side effect;
5. dispatches with the operation idempotency key;
6. records the result/evidence reference;
7. returns whether another immediate tick or an external wakeup is required.

No loop counter decides terminal state.

- [ ] **Step 4: Run controller tests and mission service regression tests**

Run: `pnpm --filter @morrow/orchestrator test -- mission-controller.test.ts mission-service.test.ts mission-kernel.test.ts mission-review-race.test.ts`

- [ ] **Step 5: Commit**

```powershell
git add -- services/orchestrator/src/mission/controller.ts services/orchestrator/src/mission/service.ts services/orchestrator/test/mission-controller.test.ts
git commit -m "feat(orchestrator): add durable mission controller"
```

### Task 7: Fenced scheduling and startup recovery

**Files:**
- Create: `services/orchestrator/src/mission/controller-runner.ts`
- Modify: `services/orchestrator/src/runner.ts`
- Modify: `services/orchestrator/src/recovery.ts`
- Modify: `services/orchestrator/src/index.ts`
- Modify: `apps/cli/src/service/lifecycle.ts`
- Create: `services/orchestrator/test/mission-controller-restart.test.ts`
- Modify: `services/orchestrator/test/execution-continuity.test.ts`
- Modify: `apps/cli/test/service-lifecycle.test.ts`

**Interfaces:**
- Consumes: `MissionController.tick`, mission-runtime leases, `TaskRunner.waitFor`, and task startup reconciliation.
- Produces: `MissionControllerRunner.run`, `wake`, `cancel`, `isActive`, `waitFor`; `reconcileMissionsOnStartup`.

- [ ] **Step 1: Write a failing abrupt-restart test**

```ts
it("reclaims the same mission and skips a completed operation after restart", async () => {
  const first = harness();
  await first.controllerRunner.run(missionId);
  first.killAfterOperation("dispatch:requirement-1");
  const second = harness({ sameDatabase: true });
  reconcileMissionsOnStartup(second.deps);
  await second.controllerRunner.waitFor(missionId);
  expect(second.runtime.get(missionId)?.missionId).toBe(missionId);
  expect(second.operations.byKey("dispatch:requirement-1")).toHaveLength(1);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @morrow/orchestrator test -- mission-controller-restart.test.ts execution-continuity.test.ts`

- [ ] **Step 3: Implement fenced controller scheduling and unified reconciliation**

The runner schedules short ticks, renews leases, wakes on worker/approval changes, and releases leases on wait/terminal state. Both `services/orchestrator/src/index.ts` and packaged `serveForeground` call one combined startup reconciler: mission controllers first, checkpoint-aware tasks second. Remove the packaged path's direct `recoverRunningTasks` call.

- [ ] **Step 4: Run restart, lifecycle, and task recovery tests**

Run: `pnpm --filter @morrow/orchestrator test -- mission-controller-restart.test.ts execution-continuity.test.ts execution-boundary.test.ts retry.test.ts`

Run: `pnpm --filter @morrow/cli test -- service-lifecycle.test.ts`

- [ ] **Step 5: Commit**

```powershell
git add -- services/orchestrator/src/mission/controller-runner.ts services/orchestrator/src/runner.ts services/orchestrator/src/recovery.ts services/orchestrator/src/index.ts apps/cli/src/service/lifecycle.ts services/orchestrator/test/mission-controller-restart.test.ts services/orchestrator/test/execution-continuity.test.ts apps/cli/test/service-lifecycle.test.ts
git commit -m "fix(orchestrator): resume mission controllers on restart"
```

### Task 8: Worker boundaries return to the controller

**Files:**
- Modify: `services/orchestrator/src/execution/agent.ts`
- Modify: `services/orchestrator/src/runner.ts`
- Modify: `services/orchestrator/src/repositories/execution-continuity.ts`
- Modify: `services/orchestrator/test/segmented-agent.test.ts`
- Modify: `services/orchestrator/test/agent-fallback.test.ts`
- Modify: `services/orchestrator/test/adaptive-budget.test.ts`
- Modify: `services/orchestrator/test/agent-completion-gate.test.ts`

**Interfaces:**
- Consumes: controller wake callbacks and progress/recovery observation contracts.
- Produces: non-terminal worker outcomes for `context_rollover_required`, `provider_recovery_required`, `strategy_change_required`, `validation_required`, and `candidate_answer_ready`.

- [ ] **Step 1: Add failing regression tests for the five observed stop modes**

Tests must prove:

- context preflight persists a checkpoint and rolls/reprojects instead of failing the mission;
- a provider-turn failure records recovery and lets the controller dispatch a replacement worker;
- legitimate investigation observations do not interrupt after three turns;
- no arbitrary segment count interrupts a mission;
- a final-looking response becomes `candidate_answer_ready`, not mission completion.

- [ ] **Step 2: Run and verify the baseline failures**

Run: `pnpm --filter @morrow/orchestrator test -- segmented-agent.test.ts agent-fallback.test.ts adaptive-budget.test.ts agent-completion-gate.test.ts`

- [ ] **Step 3: Replace worker terminal paths with durable outcomes**

For mission-linked tasks, persist the appropriate checkpoint/outcome and wake the controller. Standalone chat tasks retain truthful terminal behavior. Remove `MAX_AUTOMATIC_EXECUTION_SEGMENTS` as a terminal boundary; keep explicit cancellation, configured permission decisions, and controller policy as the bounded controls.

- [ ] **Step 4: Run the full execution-focused suite**

Run: `pnpm --filter @morrow/orchestrator test -- segmented-agent.test.ts agent-fallback.test.ts adaptive-budget.test.ts agent-completion-gate.test.ts execution-continuity.test.ts canonical-completion-invariants.test.ts agent-loop.test.ts retry.test.ts`

- [ ] **Step 5: Commit**

```powershell
git add -- services/orchestrator/src/execution/agent.ts services/orchestrator/src/runner.ts services/orchestrator/src/repositories/execution-continuity.ts services/orchestrator/test/segmented-agent.test.ts services/orchestrator/test/agent-fallback.test.ts services/orchestrator/test/adaptive-budget.test.ts services/orchestrator/test/agent-completion-gate.test.ts
git commit -m "fix(orchestrator): keep missions alive across worker boundaries"
```

### Task 9: API and CLI become observers of durable missions

**Files:**
- Modify: `services/orchestrator/src/server.ts`
- Modify: `apps/cli/src/client/api.ts`
- Modify: `apps/cli/src/commands/mission.ts`
- Modify: `apps/cli/test/mission-command.test.ts`
- Modify: `services/orchestrator/test/api-missions.test.ts`

**Interfaces:**
- Consumes: controller runner and runtime projection.
- Produces: start/status/cancel/resume endpoints and a CLI command that starts once, follows durable events, and can exit without ending the mission.

- [ ] **Step 1: Write failing API/CLI tests**

Prove that `morrow mission` starts the controller once, no longer manually sequences execute/verify/review/finalize, returns a nonzero exit code for required non-success terminal states, and reconnects to an existing mission without dispatching duplicate work.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @morrow/orchestrator test -- api-missions.test.ts`

Run: `pnpm --filter @morrow/cli test -- mission-command.test.ts`

- [ ] **Step 3: Implement controller-backed routes and CLI observation**

`POST /api/missions/:id/start` schedules the controller. `resume` wakes the same runtime after a retry condition changes. `cancel` cancels runtime and active workers. Mission GET/result responses include runtime state, current operation, blocker/disposition detail, provider/model history, and evidence counts. The CLI follows events but mission continuation does not depend on the CLI connection.

- [ ] **Step 4: Run API/CLI tests and typecheck**

Run: `pnpm --filter @morrow/orchestrator test -- api-missions.test.ts mission-controller.test.ts`

Run: `pnpm --filter @morrow/cli test -- mission-command.test.ts mission-control.test.ts`

Run: `pnpm check`

- [ ] **Step 5: Commit**

```powershell
git add -- services/orchestrator/src/server.ts apps/cli/src/client/api.ts apps/cli/src/commands/mission.ts apps/cli/test/mission-command.test.ts services/orchestrator/test/api-missions.test.ts
git commit -m "feat(cli): run missions through durable controller"
```

### Task 10: Deterministic packaged autonomy acceptance slice

**Files:**
- Modify: `apps/cli/src/acceptance/types.ts`
- Modify: `apps/cli/src/acceptance/fixture.ts`
- Modify: `apps/cli/src/acceptance/runner.ts`
- Modify: `apps/cli/src/acceptance/report.ts`
- Create: `apps/cli/src/acceptance/scenarios/durable-autonomy.ts`
- Create: `apps/cli/test/acceptance-durable-autonomy.test.ts`
- Modify: `scripts/acceptance-foundation-smoke.mjs`
- Modify: `docs/ACCEPTANCE.md`

**Interfaces:**
- Consumes: existing acceptance store/redactor/report foundation and controller-backed packaged CLI.
- Produces: versioned `durable-autonomy-v1` scenarios for premature completion, context rollover, provider failure, false no-progress, and abrupt process restart.

- [ ] **Step 1: Write failing scenario tests**

Each test injects one deterministic fault and requires evidence for same mission ID, automatic continuation, no duplicate operation key, Guardian rejection/continuation where applicable, and terminal PASS.

- [ ] **Step 2: Run and verify scenario registration failure**

Run: `pnpm --filter @morrow/cli test -- acceptance-durable-autonomy.test.ts acceptance-runner.test.ts acceptance-storage.test.ts`

- [ ] **Step 3: Generalize scenario registration without changing foundation semantics**

Keep the same run-root containment, atomic state, append-only ledger, five dispositions, source fingerprint, redaction, and report formats. Scenario-specific checks are additive and must all pass.

- [ ] **Step 4: Build and run deterministic packaged scenarios**

Run: `pnpm build`

Run: `node scripts/package-release.mjs 0.1.0-beta.30 --skip-build`

Run: `pnpm smoke:acceptance-foundation`

Run the new durable autonomy scenario through the packaged `morrow.cmd acceptance run --scenario durable-autonomy-v1` entrypoint.

Expected: PASS with retained redacted evidence under `.artifacts/acceptance-foundation` or the new versioned acceptance artifact directory.

- [ ] **Step 5: Focused security review**

Inspect only changed trust boundaries for lease fencing, operation replay, path containment, credential redaction, ambiguous effects, report leakage, and cancellation. Add a regression test for every issue found.

- [ ] **Step 6: Run slice validation**

Run: `pnpm --filter @morrow/orchestrator test`

Run: `pnpm --filter @morrow/cli test`

Run: `pnpm check`

Run: `pnpm build`

Run: `git diff --check`

- [ ] **Step 7: Commit**

```powershell
git add -- apps/cli/src/acceptance apps/cli/test/acceptance-durable-autonomy.test.ts scripts/acceptance-foundation-smoke.mjs docs/ACCEPTANCE.md
git commit -m "test(acceptance): prove durable autonomous missions"
```

## Slice completion evidence

This plan is complete only when the deterministic packaged product proves all
of the following without ordinary user input:

- one stable mission identity owns multiple worker turns/segments;
- the CLI can exit while the orchestrator continues;
- context rollover is automatic and checkpointed;
- provider/model turn failure triggers a distinct recovery;
- legitimate investigation is not false-stopped;
- process restart reclaims the same mission and skips completed operations;
- a premature provider completion is rejected by the Guardian;
- every completed mission criterion has direct evidence;
- failure reports contain attempts, evidence, strategies, retry conditions, and
  any exact external input required.
