# Mission Continuity and Context Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mission-linked agent tasks continue automatically and safely across route context limits, turn-budget segments, recoverable provider failures, and orchestrator restarts while producing one verified canonical answer.

**Architecture:** Preserve durable mission/task/tool/event records and add an additive execution-segment projection beside them. Resolve effective context from the actual provider route, measure the complete provider envelope through one preflight, persist discrete assistant turns and structured checkpoints, and treat budget/context/restart transitions as internal segment boundaries rather than terminal task outcomes.

**Tech Stack:** TypeScript 5.9, Zod 4, better-sqlite3, Fastify, Vitest, existing `js-tiktoken`, pnpm workspace.

## Global Constraints

- Work only on `fix/mission-continuity-context-preflight`; do not merge or release.
- Do not edit `apps/cli/bin/morrow.mjs` or `apps/cli/node`.
- Add no dependency unless the existing stack cannot implement the requirement cleanly.
- Preserve existing mission, task, event, provider, and Execution Kernel boundaries where practical.
- Keep opaque provider continuation state private and never expose hidden reasoning.
- A checkpoint, compaction, segment transition, provider switch, or restart is never completion.
- Every provider invocation must pass the route-aware complete-request preflight.
- Existing raw conversation/tool records remain durable and non-destructive.
- Use migration 32; never modify migrations 1–31.

---

## File map

- `services/orchestrator/src/routing/effective-context.ts`: pure canonical model/route/limit resolution.
- `services/orchestrator/src/provider/base.ts`: route metadata and private continuation protocol types.
- `services/orchestrator/src/provider/registry.ts`: route descriptions and endpoint-limit overrides.
- `services/orchestrator/src/provider/{openai-compatible,anthropic,gemini,codex}.ts`: provider continuation capture/serialization and route metadata.
- `services/orchestrator/src/execution/context-budget.ts`: complete request measurement, admission, and compaction threshold.
- `services/orchestrator/src/execution/provider-projection.ts`: deterministic provider conversation projection from durable discrete turns.
- `services/orchestrator/src/execution/checkpoint.ts`: structured checkpoint construction and compact system projection.
- `services/orchestrator/src/repositories/execution-continuity.ts`: segments, turns, private continuation records, checkpoints, and canonical answers.
- `services/orchestrator/src/database.ts`: additive migration 32.
- `services/orchestrator/src/execution/agent.ts`: segmented execution loop, preflight, discrete turn persistence, provider recovery, and final-answer ownership.
- `services/orchestrator/src/recovery.ts` and `services/orchestrator/src/runner.ts`: restart-safe resumable task reclaim.
- `services/orchestrator/src/server.ts`: shared context diagnostics and safe manual resume/compaction endpoints.
- `apps/cli/src/client/api.ts`: truthful context response shape and compact API.
- `apps/cli/src/terminal/{session,task-event-adapter,view,mission-control}.ts`: honest `/clear`, `/compact`, `/continue`, and route-limit display.
- `apps/cli/src/commands/chat.ts`: matching line-mode context and clear/help copy.
- `docs/context-management.md`, `docs/providers.md`, and `docs/architecture.md`: user-visible semantics, configuration, and durable boundary update.

### Task 1: Route-aware effective context and complete request preflight

**Files:**
- Create: `services/orchestrator/src/routing/effective-context.ts`
- Modify: `services/orchestrator/src/provider/base.ts`
- Modify: `services/orchestrator/src/provider/registry.ts`
- Modify: `services/orchestrator/src/provider/secrets.ts`
- Modify: `services/orchestrator/src/provider/openai-compatible.ts`
- Modify: `services/orchestrator/src/provider/anthropic.ts`
- Modify: `services/orchestrator/src/provider/gemini.ts`
- Modify: `services/orchestrator/src/provider/codex.ts`
- Modify: `services/orchestrator/src/execution/context-budget.ts`
- Modify: `services/orchestrator/src/mission/completion.ts`
- Test: `services/orchestrator/test/effective-context.test.ts`
- Test: `services/orchestrator/test/context-budget.test.ts`
- Test: `services/orchestrator/test/providers.test.ts`

**Interfaces:**
- Produces `resolveEffectiveContext(input: EffectiveContextInput): EffectiveContextResolution`.
- Produces `measureProviderRequest(envelope: ProviderRequestEnvelope): ProviderRequestMeasurement`.
- Produces `admitProviderRequest(envelope, resolution): ProviderAdmission`.
- Extends `AiProvider` with optional immutable `route?: ProviderRouteMetadata`.
- Extends provider configuration with `endpointContextLimit?: number` mapped to `<PROVIDER>_CONTEXT_LIMIT`.

- [ ] **Step 1: Write failing route and request-accounting tests**

```ts
it("uses the endpoint limit when advertised model capacity is larger", () => {
  const route = resolveEffectiveContext({
    providerId: "deepseek",
    selectedModel: "deepseek-v4-flash",
    endpoint: { kind: "default", host: "api.deepseek.com", limitTokens: 131_072, source: "provider-metadata" },
    outputReserveTokens: 16_384,
  });
  expect(route.advertisedModelCapacityTokens).toBe(1_000_000);
  expect(route.effectiveRequestLimitTokens).toBe(131_072);
  expect(route.maximumInputTokens).toBe(114_688);
});

it("counts tools, reasoning continuation, protocol overhead, and output reserve", () => {
  const measured = measureProviderRequest({
    providerId: "deepseek",
    model: "deepseek-reasoner",
    protocol: "openai-chat",
    messages: [{ role: "assistant", content: "", providerContinuation: { reasoningContent: "private continuation" } }],
    tools: [{ name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    outputReserveTokens: 16_384,
  });
  expect(measured.components.toolSchemas).toBeGreaterThan(0);
  expect(measured.components.providerContinuation).toBeGreaterThan(0);
  expect(measured.components.protocolOverhead).toBeGreaterThan(0);
  expect(measured.outputReserveTokens).toBe(16_384);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @morrow/orchestrator test -- effective-context.test.ts context-budget.test.ts`

Expected: failure because the resolver, envelope measurement, and endpoint override do not exist.

- [ ] **Step 3: Implement the route and request types**

```ts
export type ContextLimitSource = "model-metadata" | "provider-metadata" | "endpoint-override" | "fallback" | "unknown";
export interface ProviderRouteMetadata {
  providerId: string;
  protocol: "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-generate-content" | "mock";
  endpointKind: "default" | "custom" | "injected";
  endpointHost: string | null;
  endpointLimitTokens: number | null;
  endpointLimitSource: ContextLimitSource;
}
export interface ProviderContinuationState { reasoningContent?: string; opaque?: Record<string, unknown>; }
export interface EffectiveContextResolution {
  selectedModelId: string;
  canonicalModelId: string;
  providerId: string;
  route: ProviderRouteMetadata;
  advertisedModelCapacityTokens: number | null;
  advertisedModelCapacitySource: ContextLimitSource;
  configuredEndpointLimitTokens: number | null;
  endpointLimitSource: ContextLimitSource;
  effectiveRequestLimitTokens: number;
  effectiveLimitSource: ContextLimitSource;
  outputReserveTokens: number;
  maximumInputTokens: number;
}
```

Resolve the effective limit from the minimum positive verified route/model value. Default DeepSeek route metadata is route-specific. Custom routes use the explicit provider limit override or the existing conservative fallback and report the fallback source.

- [ ] **Step 4: Replace fixed tool reserves with complete envelope measurement and admission**

```ts
export interface ProviderRequestEnvelope {
  providerId: string;
  model: string;
  protocol: ProviderRouteMetadata["protocol"];
  messages: ChatMessage[];
  tools: ToolDefinition[];
  outputReserveTokens: number;
}
export type ProviderAdmission =
  | { ok: true; measurement: ProviderRequestMeasurement }
  | { ok: false; reason: "request_too_large"; measurement: ProviderRequestMeasurement; maximumInputTokens: number };
```

Measure serialized tool schemas and private continuation fields with the same tokenizer/estimator used for messages. Keep the safety margin explicit in the measurement rather than fabricating exactness.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter @morrow/orchestrator test -- effective-context.test.ts context-budget.test.ts provider-configure.test.ts`

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add services/orchestrator/src/routing/effective-context.ts services/orchestrator/src/provider/base.ts services/orchestrator/src/provider/registry.ts services/orchestrator/src/provider/secrets.ts services/orchestrator/src/provider/openai-compatible.ts services/orchestrator/src/provider/anthropic.ts services/orchestrator/src/provider/gemini.ts services/orchestrator/src/provider/codex.ts services/orchestrator/src/execution/context-budget.ts services/orchestrator/src/mission/completion.ts services/orchestrator/test/effective-context.test.ts services/orchestrator/test/context-budget.test.ts services/orchestrator/test/provider-configure.test.ts services/orchestrator/test/providers.test.ts
git commit -m "fix(orchestrator): resolve route-aware context limits"
```

### Task 2: Versioned durable segments, turns, checkpoints, and answers

**Files:**
- Modify: `services/orchestrator/src/database.ts`
- Create: `services/orchestrator/src/repositories/execution-continuity.ts`
- Create: `services/orchestrator/src/execution/checkpoint.ts`
- Test: `services/orchestrator/test/database-migration-32.test.ts`
- Test: `services/orchestrator/test/execution-checkpoint.test.ts`

**Interfaces:**
- Produces `executionContinuityRepository(db)` with transactional segment, turn, checkpoint, continuation, and canonical-answer methods.
- Produces `buildExecutionCheckpoint(input): ExecutionCheckpointV1` and `checkpointSystemMessage(checkpoint)`.

- [ ] **Step 1: Write failing migration and checkpoint round-trip tests**

```ts
it("migrates a version-31 database without rewriting raw history", () => {
  const db = openDatabase(path);
  expect(appliedMigrationIds(db).at(-1)).toBe(32);
  expect(tableNames(db)).toContain("agent_execution_segments");
  expect(conversationMessageCount(db)).toBe(beforeMessages);
});

it("persists requirements, failures, cursor, route, and verification evidence", () => {
  const saved = repo.saveCheckpoint(checkpoint);
  expect(repo.latestCheckpoint("task-1")).toEqual(saved);
  expect(saved.state.hardRequirements).toEqual(["must survive restart"]);
  expect(saved.state.unresolvedFailures).toEqual([expect.objectContaining({ signature: "provider-limit" })]);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @morrow/orchestrator test -- database-migration-32.test.ts execution-checkpoint.test.ts`

Expected: missing migration/tables/repository failures.

- [ ] **Step 3: Add additive migration 32**

Create the five tables from the approved specification with foreign keys, schema versions, monotonic unique keys, one-active-lease partial index, private continuation storage, and a unique canonical task answer. Add no trigger that exposes continuation JSON to FTS or task events.

- [ ] **Step 4: Implement repository transactions and checkpoint schema**

```ts
export interface ExecutionCheckpointV1 {
  version: 1;
  taskId: string;
  missionId: string | null;
  originalMission: string;
  hardRequirements: string[];
  prohibitedActions: string[];
  acceptanceCriteria: string[];
  decisions: string[];
  completedWork: string[];
  currentPhase: string;
  filesChanged: string[];
  gitStatus: string;
  tests: Array<{ command: string; exitCode: number | null; resultRef: string | null }>;
  unresolvedFailures: Array<{ signature: string; message: string; attempts: number }>;
  recoveryAttempts: string[];
  pendingWork: string[];
  approvalState: string;
  permissionState: string;
  route: EffectiveContextResolution;
  providerContinuationRefs: string[];
  lastDurableEventCursor: number;
  evidenceRequired: string[];
}
```

Use `INSERT ... ON CONFLICT` only where idempotency is intended. Reject a second different canonical answer for the same task.

- [ ] **Step 5: Run migration/checkpoint tests and verify GREEN**

Run: `pnpm --filter @morrow/orchestrator test -- database-migration-32.test.ts execution-checkpoint.test.ts database.test.ts`

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add services/orchestrator/src/database.ts services/orchestrator/src/repositories/execution-continuity.ts services/orchestrator/src/execution/checkpoint.ts services/orchestrator/test/database-migration-32.test.ts services/orchestrator/test/execution-checkpoint.test.ts
git commit -m "feat(orchestrator): persist mission execution segments"
```

### Task 3: Deterministic non-amplifying provider projection

**Files:**
- Create: `services/orchestrator/src/execution/provider-projection.ts`
- Modify: `services/orchestrator/src/repositories/conversations.ts`
- Modify: `services/orchestrator/src/provider/openai-compatible.ts`
- Test: `services/orchestrator/test/provider-projection.test.ts`
- Test: `services/orchestrator/test/providers.test.ts`

**Interfaces:**
- Produces `buildProviderProjection(input: ProjectionInput): ChatMessage[]`.
- Produces `projectionFingerprint(messages): string`.
- `ProviderChunk` carries private `providerContinuation` only in-process.

- [ ] **Step 1: Write failing idempotence, narration, and linear-growth tests**

```ts
it("rebuilding identical durable history does not change tokens", () => {
  const first = buildProviderProjection(fixture);
  const second = buildProviderProjection(fixture);
  expect(second).toEqual(first);
  expect(count(first)).toBe(count(second));
});

it("projects each assistant narration exactly once", () => {
  const messages = buildProviderProjection(twoTurnFixture);
  expect(messages.filter(m => m.role === "assistant").map(m => m.content)).toEqual(["first", "second"]);
});

it("tool history grows once per distinct event", () => {
  expect(toolMessageCount(project(turns(10)))).toBe(10);
  expect(toolMessageCount(project(turns(20)))).toBe(20);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @morrow/orchestrator test -- provider-projection.test.ts providers.test.ts`

Expected: projection API and continuation support are missing.

- [ ] **Step 3: Implement projection from discrete turns and raw tool records**

Project conversation messages that precede the active task once, then project
`agent_provider_turns` in turn order. Each turn references its own tool call ids;
join one tool result per id. Never use the cumulative assistant presentation
message as active-task provider history.

- [ ] **Step 4: Preserve DeepSeek continuation fields privately**

Parse streamed `reasoning_content` into `ProviderChunk.providerContinuation`,
persist it through the private repository, include it in compatible subsequent
wire messages and accounting, and omit it from every public event/aggregate.

- [ ] **Step 5: Run projection/provider tests and verify GREEN**

Run: `pnpm --filter @morrow/orchestrator test -- provider-projection.test.ts providers.test.ts context-budget.test.ts`

Expected: all selected tests pass with linear projection growth.

- [ ] **Step 6: Commit**

```bash
git add services/orchestrator/src/execution/provider-projection.ts services/orchestrator/src/repositories/conversations.ts services/orchestrator/src/provider/openai-compatible.ts services/orchestrator/test/provider-projection.test.ts services/orchestrator/test/providers.test.ts
git commit -m "fix(orchestrator): project provider turns without amplification"
```

### Task 4: Segmented agent execution, compaction, and provider recovery

**Files:**
- Modify: `services/orchestrator/src/execution/agent.ts`
- Modify: `services/orchestrator/src/provider/fallback.ts`
- Modify: `services/orchestrator/src/execution/adaptive-budget.ts`
- Test: `services/orchestrator/test/mission-continuity.test.ts`
- Test: `services/orchestrator/test/agent-loop.test.ts`
- Test: `services/orchestrator/test/agent-fallback.test.ts`

**Interfaces:**
- The agent executor owns an outer segment loop and an inner bounded turn loop.
- `prepareSegmentProjection` checkpoints/compacts/remeasures before invocation.
- `openStreamWithFallback` receives candidate-specific admitted envelopes.

- [ ] **Step 1: Write failing no-call, auto-continuation, compaction, and provider-recovery tests**

```ts
it("does not invoke a provider for a 148403-token request on a 131072 route", async () => {
  await executeAgentChatTask(fixture({ requestTokens: 148_403, routeLimit: 131_072 }));
  expect(provider.calls).toBe(0);
});

it("continues a productive task across turn segments without user input", async () => {
  await executeAgentChatTask(fixture({ segmentTurnLimit: 3, productiveTurns: 8 }));
  expect(task().status).toBe("completed");
  expect(segments()).toHaveLength(3);
  expect(eventsOfType("task.interrupted")).toHaveLength(0);
});

it("preserves requirements, failures, and continuation refs during compaction", () => {
  expect(compactedCheckpoint()).toMatchObject({
    hardRequirements: originalRequirements,
    unresolvedFailures: originalFailures,
    providerContinuationRefs: [continuationId],
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @morrow/orchestrator test -- mission-continuity.test.ts agent-loop.test.ts agent-fallback.test.ts`

Expected: adaptive budget interrupts, oversize handling is terminal, and provider turns are not segmented.

- [ ] **Step 3: Refactor the agent loop to persist one turn before tools**

Track `turnText` separately from presentation `responseContent`. Persist the
turn with its tool ids, then append the same discrete text to the projection.
Store the canonical answer only for a final turn. Existing tool execution and
approval boundaries remain in place.

- [ ] **Step 4: Add threshold compaction and internal segment rollover**

Use a configurable default threshold of 80% of `maximumInputTokens`. Before the
threshold is crossed, persist the checkpoint, build its system projection,
retain recent raw turn groups, remeasure, close the current segment, and open the
next. Turn-budget exhaustion uses the same path and never transitions the task.

- [ ] **Step 5: Recover provider failures with a fresh route-bound segment**

Retry only normalized recoverable provider failures. Bind private continuation
to matching route/model/protocol; otherwise start from the checkpoint without
it. Record provider context rejection as route evidence and permit one stricter
fresh-segment compaction, never an unchanged request.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm --filter @morrow/orchestrator test -- mission-continuity.test.ts agent-loop.test.ts agent-fallback.test.ts agent-alpha.test.ts`

Expected: all selected tests pass; no routine segment emits task interruption.

- [ ] **Step 7: Commit**

```bash
git add services/orchestrator/src/execution/agent.ts services/orchestrator/src/provider/fallback.ts services/orchestrator/src/execution/adaptive-budget.ts services/orchestrator/test/mission-continuity.test.ts services/orchestrator/test/agent-loop.test.ts services/orchestrator/test/agent-fallback.test.ts
git commit -m "fix(orchestrator): continue agent work across segments"
```

### Task 5: Restart reclaim and duplicate-side-effect prevention

**Files:**
- Modify: `services/orchestrator/src/recovery.ts`
- Modify: `services/orchestrator/src/runner.ts`
- Modify: `services/orchestrator/src/repositories/task-records.ts`
- Test: `services/orchestrator/test/recovery.test.ts`
- Test: `services/orchestrator/test/mission-continuity-restart.test.ts`

**Interfaces:**
- `reconcileTasksOnStartup` returns `resumedCheckpointed` in addition to existing counters.
- `TaskRunner.run(taskId, { recovered: true, resumeCheckpoint: true })` reclaims a durable segment without appending `task.created` or a terminal interruption.

- [ ] **Step 1: Write failing restart and replay-idempotency tests**

```ts
it("reclaims a checkpointed running mission task after restart", () => {
  const result = reconcileTasksOnStartup({ db, runner });
  expect(result.resumedCheckpointed).toBe(1);
  expect(task("t").status).toBe("running");
  expect(runner.runs).toEqual(["t"]);
});

it("does not duplicate completed writes or task events after restart", async () => {
  await runBeforeAndAfterRestart();
  expect(fileWriteCount("src/result.ts")).toBe(1);
  expect(uniqueEventIds().size).toBe(allEvents().length);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @morrow/orchestrator test -- recovery.test.ts mission-continuity-restart.test.ts`

Expected: restart marks the task interrupted and does not resume it.

- [ ] **Step 3: Implement lease-backed startup reclaim**

Within startup reconciliation, claim only tasks with a valid durable checkpoint
and no pending human approval or user budget stop. Preserve their running task
status, close the abandoned segment, open a recovered segment, and dispatch once.
Keep the existing interrupted behavior for unknown in-flight tasks.

- [ ] **Step 4: Reconcile persisted tool outcomes before replay**

Completed tool calls become observations. Applied change sets are verified by
post-apply hashes. A running ambiguous tool call is recorded in the checkpoint
and never blindly executed twice.

- [ ] **Step 5: Run restart tests and verify GREEN**

Run: `pnpm --filter @morrow/orchestrator test -- recovery.test.ts mission-continuity-restart.test.ts cancellation-lifecycle.test.ts`

Expected: checkpointed missions resume automatically with no duplicate write/event.

- [ ] **Step 6: Commit**

```bash
git add services/orchestrator/src/recovery.ts services/orchestrator/src/runner.ts services/orchestrator/src/repositories/task-records.ts services/orchestrator/test/recovery.test.ts services/orchestrator/test/mission-continuity-restart.test.ts
git commit -m "fix(orchestrator): resume checkpointed missions after restart"
```

### Task 6: Safe manual recovery and honest context/clear UI

**Files:**
- Modify: `services/orchestrator/src/server.ts`
- Modify: `apps/cli/src/client/api.ts`
- Modify: `apps/cli/src/terminal/session.ts`
- Modify: `apps/cli/src/terminal/task-event-adapter.ts`
- Modify: `apps/cli/src/terminal/view.ts`
- Modify: `apps/cli/src/terminal/mission-control.ts`
- Modify: `apps/cli/src/commands/chat.ts`
- Test: `services/orchestrator/test/task-resume-context.test.ts`
- Test: `apps/cli/test/terminal-context-command.test.ts`
- Test: `apps/cli/test/terminal-session-harness.test.ts`

**Interfaces:**
- Context aggregates expose nullable advertised/endpoint capacities, effective limit, output reserve, maximum input, current request, and sources.
- `POST /api/tasks/:taskId/compact` persists a checkpoint/projection compaction without clearing raw history.
- Resume performs local preflight before dispatch.

- [ ] **Step 1: Write failing `/continue`, `/context`, `/clear`, and `/compact` tests**

```ts
it("refuses unchanged deterministic oversize resume before provider invocation", async () => {
  const response = await app.inject({ method: "POST", url: "/api/tasks/t/resume", payload: { projectId: "p" } });
  expect(response.statusCode).toBe(409);
  expect(provider.calls).toBe(0);
  expect(response.json().error.message).not.toContain("try /continue");
});

it("labels clear as screen-only", async () => {
  await submit("/clear");
  expect(notices()).toContainEqual(expect.stringContaining("screen only"));
  expect(notices()).toContainEqual(expect.stringContaining("provider context unchanged"));
});
```

- [ ] **Step 2: Run focused orchestrator/CLI tests and verify RED**

Run: `pnpm --filter @morrow/orchestrator test -- task-resume-context.test.ts && pnpm --filter @morrow/cli test -- terminal-context-command.test.ts terminal-session-harness.test.ts`

Expected: context shape is model-only, resume dispatches unchanged, and clear has no notice.

- [ ] **Step 3: Implement shared context aggregate and safe resume/compact routes**

Build API data exclusively from persisted effective-context/preflight events or
segment route snapshots. Do not recompute a second UI limit. Resume compacts and
remeasures before runner dispatch; deterministic refusal returns a specific
recovery action and no provider call.

- [ ] **Step 4: Update CLI rendering and commands**

Render `unknown` for nullable values. Show model capacity, endpoint limit,
effective limit, reserved output, maximum input, current request, and each
source. `/clear` displays the screen-only notice. `/compact` calls the compact
endpoint. Paused/failed views recommend `/continue` only when the aggregate says
automatic/manual recovery is admissible.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter @morrow/orchestrator test -- task-resume-context.test.ts && pnpm --filter @morrow/cli test -- terminal-context-command.test.ts terminal-session-harness.test.ts terminal-mission-console.test.ts`

Expected: all selected tests pass with honest matching limits.

- [ ] **Step 6: Commit**

```bash
git add services/orchestrator/src/server.ts apps/cli/src/client/api.ts apps/cli/src/terminal/session.ts apps/cli/src/terminal/task-event-adapter.ts apps/cli/src/terminal/view.ts apps/cli/src/terminal/mission-control.ts apps/cli/src/commands/chat.ts services/orchestrator/test/task-resume-context.test.ts apps/cli/test/terminal-context-command.test.ts apps/cli/test/terminal-session-harness.test.ts
git commit -m "fix(cli): report and recover provider context honestly"
```

### Task 7: Completion ownership and decisive reproduction

**Files:**
- Modify: `services/orchestrator/src/mission/service.ts`
- Modify: `services/orchestrator/src/mission/result.ts`
- Modify: `services/orchestrator/src/repositories/missions.ts`
- Test: `services/orchestrator/test/mission-completion-continuity.test.ts`
- Test: `services/orchestrator/test/mission-incident-852da246.test.ts`

**Interfaces:**
- Full mission completion checks canonical task answer and evidence cursor in addition to existing requirement/review gates.
- Exactly one canonical task answer is accepted; identical retries are idempotent and differing retries are rejected.

- [ ] **Step 1: Write failing completion and incident-reproduction tests**

```ts
it("blocks full completion until acceptance criteria and required tests pass", () => {
  expect(() => service.finalize(missionId)).toThrow(/verification|canonical answer/i);
});

it("produces exactly one canonical final answer across recovery", async () => {
  await runIncidentClassFixture();
  expect(repo.listCanonicalAnswers(missionTaskId)).toHaveLength(1);
});

it("completes task 852da246 reproduction class under the effective endpoint limit", async () => {
  const result = await runIncidentClassFixture({ effectiveLimit: 131_072 });
  expect(result.providerRequests.every(r => r.inputTokens + r.outputReserveTokens <= 131_072)).toBe(true);
  expect(result.segments.length).toBeGreaterThan(1);
  expect(result.restartRecovered).toBe(true);
  expect(result.providerFailureRecovered).toBe(true);
  expect(result.userContinueCount).toBe(0);
  expect(result.mission.status).toBe("completed");
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @morrow/orchestrator test -- mission-completion-continuity.test.ts mission-incident-852da246.test.ts`

Expected: mission finalization does not know the canonical answer/evidence cursor and the reproduction cannot span segments/restart.

- [ ] **Step 3: Strengthen finalization transaction**

Require the mission-linked root task's unique canonical answer and a checkpoint
evidence cursor that covers the required successful verification records before
allowing `completed`. Keep partial/blocked grading honest and preserve existing
review-cycle transaction invariants.

- [ ] **Step 4: Complete the deterministic incident fixture**

Use mock providers and deterministic token weights; do not contact a live
provider. Simulate multiple segments, a restart boundary, one recoverable
provider failure, one file write, verification, and review. Assert no request
exceeds the effective limit and no user resume occurs.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter @morrow/orchestrator test -- mission-completion-continuity.test.ts mission-incident-852da246.test.ts mission-kernel.test.ts mission-kernel-contract.test.ts mission-review-race.test.ts`

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add services/orchestrator/src/mission/service.ts services/orchestrator/src/mission/result.ts services/orchestrator/src/repositories/missions.ts services/orchestrator/test/mission-completion-continuity.test.ts services/orchestrator/test/mission-incident-852da246.test.ts
git commit -m "fix(mission): require verified canonical completion"
```

### Task 8: Documentation, independent reviews, repairs, and final validation

**Files:**
- Modify: `docs/context-management.md`
- Modify: `docs/providers.md`
- Modify: `docs/architecture.md`
- Modify when a validated finding applies: the exact Task 1–7 production or test file named by that finding

- [ ] **Step 1: Document route limits, automatic compaction/continuation, restart semantics, `/clear`, `/compact`, privacy, and rollback**

Document the endpoint limit override names and explicitly state that model
capacity and endpoint capacity can differ. Record the new durable projection
boundary in architecture documentation.

- [ ] **Step 2: Run independent requirements-compliance and hostile failure reviews in parallel**

The compliance reviewer maps every required behavior/regression to code and
tests. The hostile reviewer probes incorrect metadata, endpoint overrides,
checkpoint/provider crash ordering, duplicate replay, stale continuation,
compaction failure, post-preflight provider rejection, and verification failure.

- [ ] **Step 3: Repair all validated Critical/Important findings with fresh failing tests first**

Run the focused tests for each repair and record the exact findings and outcomes.

- [ ] **Step 4: Run the prescribed validation once at the end**

```bash
pnpm --filter @morrow/cli check
pnpm --filter @morrow/cli test
pnpm --filter @morrow/orchestrator check
pnpm --filter @morrow/orchestrator test
pnpm check
pnpm test
pnpm build
git diff --check
git status --short
git diff --stat main
git diff main
git ls-files --others --exclude-standard
```

Also run the focused restart, provider, mission-kernel, adaptive-budget,
context, task-resume, and migration tests from Tasks 1–7 and preserve their
exact results.

- [ ] **Step 5: Commit the implementation with the requested final message**

```bash
git add --all
git commit -m "fix(orchestrator): make advanced missions continue across context limits"
```

- [ ] **Step 6: Push and open a non-merged pull request into `main`**

```bash
git push -u origin fix/mission-continuity-context-preflight
gh pr create --base main --head fix/mission-continuity-context-preflight --title "fix(orchestrator): make advanced missions continue across context limits" --body "Implements route-aware context preflight, durable segmented mission execution, restart recovery, automatic compaction/continuation, and honest CLI context controls. Includes focused incident regressions, security/privacy notes, validation evidence, and rollback guidance. This pull request must not be merged automatically."
```

Never merge the pull request.
