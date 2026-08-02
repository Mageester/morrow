# Real-task Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing flagship workflow pass at least 9 of its latest 10 real runs on each of two providers while structurally preventing known mission-completion failures.

**Architecture:** Introduce one coordinated terminal-outcome boundary for mission, runtime, and worker state; enforce canonical model identity and explicit requirements before completion; then use real-provider canaries to drive any remaining fixes. Every confirmed defect receives a class-level coverage table rather than a model- or adapter-specific assertion.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Vitest 4, better-sqlite3, pnpm/Turborepo, provider SSE adapters, append-only JSONL evidence.

## Global Constraints

- Work only on `codex/reliable-task-completion`; never merge directly to `main`.
- Prefer free frontier-capable models. Use a paid model only for a controlled comparison when a free failure may be model-quality-specific.
- Never print, log, commit, or copy provider credential values.
- Never edit or delete an existing line in `docs/evidence/flagship-runs.jsonl`.
- Never record a mock or synthetic run as a real pass.
- Preserve local-first behavior, provider choice, explicit permissions, and private reasoning continuation.
- Every behavior change starts with a reproducible failing test and ends with focused verification.
- Changes to execution, providers, unattended work, credentials, or private continuation require explicit security review before merge.
- No new providers, modes, UI surfaces, memory features, persistent agents, scheduling, MCP expansion, signing, macOS, or distribution work.

## File map

- `services/orchestrator/src/mission/terminal-outcome.ts`: new pure lifecycle policy and terminal-entry coverage registry.
- `services/orchestrator/src/mission/service.ts`: coordinates verification/result persistence while preserving terminal status.
- `services/orchestrator/src/mission/tool-failure-reporter.ts`: signals exhaustion to the executing agent without silently terminating only the mission row.
- `services/orchestrator/src/mission/controller.ts`: delegates every terminal runtime path to the same close-out dependency.
- `services/orchestrator/src/mission/controller-runner.ts`: cancels the exact authoritative worker and resumes interrupted close-out.
- `services/orchestrator/src/runner.ts`: accepts an internal cancellation reason without weakening user-cancellation behavior.
- `services/orchestrator/test/mission-terminal-outcome-conformance.test.ts`: table-driven class guard for all terminal entry paths.
- `services/orchestrator/test/mission-accountability-closure.test.ts`: evidence/result close-out integration cases.
- `services/orchestrator/src/routing/models.ts`: canonical-target metadata for legacy selections.
- `services/orchestrator/test/model-identity-conformance.test.ts`: catalog-wide alias/canonical coverage guard.
- `services/orchestrator/src/execution/requirements.ts`: deterministic explicit-constraint extraction and observation evaluation.
- `services/orchestrator/src/execution/agent.ts`: tool-boundary enforcement and completion integration.
- `services/orchestrator/test/agent-requirement-conformance.test.ts`: table-driven requirement-kind coverage.
- `services/orchestrator/src/execution/completion-contract.ts`: task-shape completion contracts and evidence evaluation.
- `services/orchestrator/test/agent-completion-contract.test.ts`: file, CLI, frontend, and read-only completion coverage.
- `services/orchestrator/test/execution-boundary-conformance.test.ts`: all tool profiles and provider-continuation privacy coverage.
- `services/orchestrator/test/live/flagship-build.test.ts`: declared provider eligibility and real canary execution.
- `services/orchestrator/src/acceptance/flagship-build.ts`: preserve failure classification and add only evidence required by live diagnosis.
- `docs/decisions/0011-terminal-outcomes-and-requirement-enforcement.md`: new lifecycle/security invariant.
- `docs/evidence/flagship-runs.jsonl`: append-only real run results.

---

### Task 1: Coordinate terminal mission, runtime, and worker state

**Files:**
- Create: `services/orchestrator/src/mission/terminal-outcome.ts`
- Create: `services/orchestrator/test/mission-terminal-outcome-conformance.test.ts`
- Modify: `services/orchestrator/src/mission/service.ts:415-480,975-1225`
- Modify: `services/orchestrator/src/mission/tool-failure-reporter.ts:45-90`
- Modify: `services/orchestrator/src/mission/controller.ts:150-170,500-520`
- Modify: `services/orchestrator/src/mission/controller-runner.ts:30-180,330-375`
- Modify: `services/orchestrator/src/runner.ts:135-220`
- Test: `services/orchestrator/test/mission-accountability-closure.test.ts`

**Interfaces:**
- Produces: `TerminalEntryKind`, `TERMINAL_ENTRY_KINDS`, `terminalDispositionForMission(status)`, and `MissionService.concludeTerminalOutcome(missionId, input)`.
- Changes: `TaskRunner.cancel(taskId, reason?: "user_cancelled" | "parent_cancelled" | "mission_terminal")`.
- Changes: `MissionToolFailureReporter.reportFailure(...)` returns `{ exhausted: boolean }` so the agent can stop issuing provider turns.
- Preserves: existing `MissionService.finalize()` integrity checks for successful completion tuples.

- [ ] **Step 1: Write the terminal-entry conformance test**

Create a table containing `normal_finalize`, `user_cancel`, `controller_exhausted`, `tool_loop_exhausted`, `revision_limit`, and `startup_reconciliation`. For each entry, assert that after the scenario settles:

```ts
expect(mission.status).toBe(expectedStatus);
expect(runtime.state).toBe(expectedRuntimeState);
expect(["completed", "failed", "cancelled", "interrupted"]).toContain(task.status);
expect(taskRunner.isActive(task.id)).toBe(false);
expect(events.filter((event) => event.type === "mission.conclusion_started")).toHaveLength(1);
expect(events.filter((event) => event.type === "mission.terminal_outcome_recorded")).toHaveLength(1);
expect(mission.result?.status).toBe(mission.status);
```

Also assert that `new Set(TERMINAL_ENTRY_KINDS)` exactly equals the table keys so a new terminal path cannot enter undeclared.

- [ ] **Step 2: Run the test and capture the current split-brain failure**

Run:

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/mission-terminal-outcome-conformance.test.ts
```

Expected: `tool_loop_exhausted` fails because the mission is `blocked` while runtime/task remain executing/running and no result exists.

- [ ] **Step 3: Add the pure terminal policy**

Implement:

```ts
export const TERMINAL_ENTRY_KINDS = [
  "normal_finalize",
  "user_cancel",
  "controller_exhausted",
  "tool_loop_exhausted",
  "revision_limit",
  "startup_reconciliation",
] as const;
export type TerminalEntryKind = typeof TERMINAL_ENTRY_KINDS[number];

export function terminalDispositionForMission(status: MissionStatus): MissionRuntimeState {
  if (status === "cancelled") return "cancelled";
  if (status === "completed" || status === "completed_with_reservations") return "completed";
  return "blocked";
}
```

Keep this module independent of the database so the lifecycle matrix is exhaustively testable.

- [ ] **Step 4: Make task cancellation carry an internal terminal reason**

Extend `TaskRunner.cancel` and `cancelOne` so `mission_terminal` aborts only the exact task tree and persists `cancelled` with `payload.reason = "mission_terminal"`. Preserve `user_cancelled` for the public path and `parent_cancelled` for descendants.

- [ ] **Step 5: Replace direct loop-terminal mutation with a close-out request**

Change the reporter result to:

```ts
export interface MissionFailureReportResult {
  exhausted: boolean;
}
```

Return `exhausted: plan.exhausted && attempt >= 4` from `reportFailure`. In the agent loop, set a durable blocker and end the current execution segment after the failed tool result is persisted; do not open another provider stream.

- [ ] **Step 6: Implement idempotent terminal close-out**

Add:

```ts
async concludeTerminalOutcome(
  missionId: string,
  input: { kind: TerminalEntryKind; reason: string; preserveStatus?: MissionStatus },
): Promise<Mission>
```

The method must append `mission.conclusion_started` only when absent, call `verifyAll(..., { revisePlanOnFailure: false })` once, compute a result pinned to `preserveStatus ?? current.status`, and append `mission.terminal_outcome_recorded` transactionally with the result. If a complete terminal outcome already exists, return it unchanged. If persisted values contradict each other, throw `finalization_integrity_error`.

- [ ] **Step 7: Wire the controller runner as the synchronization owner**

Before terminal runtime transition, call `taskRunner.cancel(activeTaskId, "mission_terminal")`, await `waitFor(activeTaskId)`, call `concludeTerminalOutcome`, then transition runtime to `terminalDispositionForMission(mission.status)`. Startup reconciliation invokes the same method when a terminal mission lacks `mission.terminal_outcome_recorded`.

- [ ] **Step 8: Run focused lifecycle tests**

Run:

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/mission-terminal-outcome-conformance.test.ts test/mission-accountability-closure.test.ts test/mission-controller.test.ts test/mission-controller-restart.test.ts test/mission-controller-production.test.ts test/runner.test.ts
```

Expected: all pass; no scenario leaves an active worker after terminal mission status.

- [ ] **Step 9: Commit the lifecycle invariant**

```powershell
git add services/orchestrator/src/mission/terminal-outcome.ts services/orchestrator/src/mission/service.ts services/orchestrator/src/mission/tool-failure-reporter.ts services/orchestrator/src/mission/controller.ts services/orchestrator/src/mission/controller-runner.ts services/orchestrator/src/runner.ts services/orchestrator/test/mission-terminal-outcome-conformance.test.ts services/orchestrator/test/mission-accountability-closure.test.ts
git commit -m "fix(orchestrator): coordinate terminal mission outcomes"
```

### Task 2: Canonicalize every model selection before metadata use

**Files:**
- Modify: `services/orchestrator/src/routing/models.ts:45-75,140-150,220-240`
- Create: `services/orchestrator/test/model-identity-conformance.test.ts`
- Modify: `services/orchestrator/test/effective-context.test.ts:70-90`

**Interfaces:**
- Produces: `canonicalTarget?: { providerId: ProviderId; modelId: string }` on bundled model declarations.
- Produces: `resolveCanonicalModelMetadata(providerId, selectedId): { selected: ModelInfo; canonical: ModelInfo }`.
- Preserves: selected legacy id and reasoning mode for provider requests and UI disclosure.

- [ ] **Step 1: Write the catalog-wide failing guard**

Iterate every bundled model and alias. Assert exact provider-local resolution, no cycles, and either a canonical target or complete independent metadata. Add explicit expectations:

```ts
expect(resolveCanonicalModelMetadata("deepseek", "deepseek-chat").canonical.id)
  .toBe("deepseek-v4-flash");
expect(resolveCanonicalModelMetadata("deepseek", "deepseek-reasoner").canonical.contextWindow)
  .toBe(1_000_000);
expect(resolveReasoningCapability("deepseek", "deepseek-reasoner").control)
  .toBe("fixed");
```

- [ ] **Step 2: Verify the current metadata failure**

Run:

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/model-identity-conformance.test.ts test/effective-context.test.ts
```

Expected: legacy DeepSeek selections fail with `contextWindow === null` and canonical ids equal to themselves.

- [ ] **Step 3: Implement canonical-target resolution**

Declare both legacy DeepSeek entries with canonical target `deepseek-v4-flash`. Resolve shared context, output, pricing, and capability facts from the canonical entry, then overlay selection-specific lifecycle and reasoning fields. Reject missing targets, provider changes, and cycles during catalog validation.

- [ ] **Step 4: Route every metadata consumer through the resolver**

Update `resolveModelMetadata` to return the merged selected/canonical view. Confirm `effective-context.ts`, reasoning selection, pricing disclosure, and provider route fingerprinting receive canonical facts without changing the outbound selected model id.

- [ ] **Step 5: Run routing and catalog tests**

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/model-identity-conformance.test.ts test/effective-context.test.ts test/reasoning-capability-consistency.test.ts test/provider-limits.test.ts
```

Expected: all pass; both legacy ids advertise the canonical 1,000,000-token capacity.

- [ ] **Step 6: Commit canonical identity**

```powershell
git add services/orchestrator/src/routing/models.ts services/orchestrator/test/model-identity-conformance.test.ts services/orchestrator/test/effective-context.test.ts
git commit -m "fix(routing): canonicalize model metadata aliases"
```

### Task 3: Enforce explicit hard requirements as observable contracts

**Files:**
- Create: `services/orchestrator/src/execution/requirements.ts`
- Create: `services/orchestrator/test/agent-requirement-conformance.test.ts`
- Modify: `services/orchestrator/src/execution/agent.ts:2650-2720,3750-3880,4900-5020`
- Modify: `services/orchestrator/src/mission/contract-extractor.ts:80-155`
- Modify: `services/orchestrator/src/mission/objective-requirements.ts:50-235`

**Interfaces:**
- Produces: `RequirementKind = "no_frontend" | "no_database" | "no_new_dependencies" | "allowed_files" | "required_file" | "required_verification"`.
- Produces: `extractExecutionRequirements(prompt): ExecutionRequirement[]`.
- Produces: `evaluateRequirementObservations(requirements, observations): RequirementEvaluation[]`.
- Produces: `enforceToolRequirement(call, requirements): { allowed: true } | { allowed: false; resultJson: string }`.

- [ ] **Step 1: Write a table-driven requirement guard**

For every `RequirementKind`, supply one compliant and one violating tool/diff observation. Assert extraction, pre-action enforcement where possible, post-action evaluation, and completion status. Assert the case table keys exactly equal the exported requirement registry.

Include the known reproduction:

```ts
const prompt = "Build the backend only. No frontend, no database, and no new dependencies.";
expect(extractExecutionRequirements(prompt).map((item) => item.kind)).toEqual([
  "no_frontend",
  "no_database",
  "no_new_dependencies",
]);
```

- [ ] **Step 2: Run the requirement test and prove absence of enforcement**

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/agent-requirement-conformance.test.ts
```

Expected: the current agent allows frontend/database/dependency-producing actions and can complete with violations unevaluated.

- [ ] **Step 3: Implement deterministic extraction**

Parse only explicit, high-confidence phrases. Store the exact source excerpt, kind, normalized parameters, and authoritative status. Unmapped explicit constraints remain `unevaluated` and block unqualified completion instead of being guessed.

- [ ] **Step 4: Enforce at the tool boundary**

Before `create_file`, `propose_patch`, and dependency-installing `run_command`, compare the normalized tool call with active requirements. Return an `AgentToolFailure` with `errorType = "requirement_violation"`, the requirement id, source excerpt, and a correction instruction. Do not widen approvals or execute the rejected action.

- [ ] **Step 5: Evaluate actual workspace observations**

After mutations, derive observations from changed paths, package manifests, lockfiles, and recorded commands. A prohibition is verified only when the final diff contains no conflicting observation; a detected conflict marks it failed with evidence.

- [ ] **Step 6: Gate canonical completion**

Before the task transitions to `completed`, require every authoritative execution requirement to be `verified` or explicitly `waived`. Persist the evaluation in the checkpoint and canonical evidence. Use `partially_completed`/`interrupted` rather than claiming full success when evaluation is failed or unavailable.

- [ ] **Step 7: Run focused requirement and security tests**

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/agent-requirement-conformance.test.ts test/mission-kernel-contract.test.ts test/agent-security.test.ts test/command-policy.test.ts
```

Expected: all pass; prohibited changes never execute, and unresolved explicit constraints prevent full completion.

- [ ] **Step 8: Commit requirement enforcement**

```powershell
git add services/orchestrator/src/execution/requirements.ts services/orchestrator/src/execution/agent.ts services/orchestrator/src/mission/contract-extractor.ts services/orchestrator/src/mission/objective-requirements.ts services/orchestrator/test/agent-requirement-conformance.test.ts
git commit -m "fix(orchestrator): enforce explicit task requirements"
```

### Task 4: Make completion evidence-driven for every declared task shape

**Files:**
- Create: `services/orchestrator/src/execution/completion-contract.ts`
- Create: `services/orchestrator/test/agent-completion-contract.test.ts`
- Modify: `services/orchestrator/src/execution/agent.ts:2380-2510,4700-5020`
- Modify: `services/orchestrator/test/agent-completion-gate.test.ts`
- Modify: `services/orchestrator/test/flagship-build.test.ts`

**Interfaces:**
- Produces: `TaskShape = "read_only" | "file_delivery" | "cli_application" | "frontend_application"`.
- Produces: `TASK_COMPLETION_CONTRACTS: Record<TaskShape, CompletionContract>`.
- Produces: `evaluateTaskCompletion(input): { complete: boolean; blockers: CompletionBlocker[] }`.

- [ ] **Step 1: Write the completion-contract coverage table**

Assert each task shape's required evidence and a coverage equality check. For `cli_application`, feed a correct written artifact plus passed independent commands followed by repeated read-only process polling; expect `complete: true` before the stall interruption. Feed a failed final verification; expect `complete: false`.

- [ ] **Step 2: Verify the current completion failure**

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/agent-completion-contract.test.ts test/agent-completion-gate.test.ts test/flagship-build.test.ts
```

Expected: the verified-artifact/repeated-observation case ends interrupted or lacks a declared contract.

- [ ] **Step 3: Extract the existing scattered gates into contracts**

Move read-only, write/verification, and frontend browser evidence rules into `TASK_COMPLETION_CONTRACTS`. Keep the current hard checks: failed last mutation/verification, missing canonical final answer, and incomplete frontend viewport/console/interaction evidence remain blockers.

- [ ] **Step 4: Close verified work before stagnation recovery**

At the end of a provider turn and before incrementing stagnation counters, evaluate the task contract. When complete, persist a concise canonical final answer and transition the task to `completed`; do not request another provider turn. File existence or model narration alone never satisfies the evaluator.

- [ ] **Step 5: Run completion and flagship harness tests**

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/agent-completion-contract.test.ts test/agent-completion-gate.test.ts test/agent-frontend-validation-vision-gate.test.ts test/flagship-build.test.ts test/journey-g-self-hosting-integrity.test.ts
```

Expected: all pass; verified delivery completes while failed verification remains non-complete.

- [ ] **Step 6: Commit completion contracts**

```powershell
git add services/orchestrator/src/execution/completion-contract.ts services/orchestrator/src/execution/agent.ts services/orchestrator/test/agent-completion-contract.test.ts services/orchestrator/test/agent-completion-gate.test.ts services/orchestrator/test/flagship-build.test.ts
git commit -m "fix(orchestrator): complete tasks from durable evidence"
```

### Task 5: Guard read-only constraints and private provider continuation as classes

**Files:**
- Create: `services/orchestrator/test/execution-boundary-conformance.test.ts`
- Modify only if the guard finds a defect: `services/orchestrator/src/execution/agent.ts`
- Modify only if the guard finds a defect: `services/orchestrator/src/provider/base.ts`
- Modify only if the guard finds a defect: `services/orchestrator/src/provider/openai-compatible.ts`

**Interfaces:**
- Consumes: exported tool-profile registry, provider protocol registry, `providerRouteFingerprint`, and `ProviderContinuationState`.
- Produces: no new behavior unless a current participant violates the declared boundary.

- [ ] **Step 1: Write the cross-profile/cross-protocol guard**

For every tool profile (`none`, `read-only`, `agent`), assert denied execution tools become structured `tool_not_permitted_in_mode` results and never prevent a valid final answer. For every continuation-capable protocol, assert reasoning continuation is persisted/replayed only on identical route fingerprints and is absent from task events, web projections, CLI output, and diagnostic exports.

- [ ] **Step 2: Run the guard**

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/execution-boundary-conformance.test.ts test/agent-background-process.test.ts test/execution-continuity.test.ts test/context-budget.test.ts
```

Expected: existing read-only and DeepSeek continuation behavior passes. Any failure becomes a separately reproduced minimal fix in the named boundary file.

- [ ] **Step 3: Commit the class guard**

```powershell
git add services/orchestrator/test/execution-boundary-conformance.test.ts services/orchestrator/src/execution/agent.ts services/orchestrator/src/provider/base.ts services/orchestrator/src/provider/openai-compatible.ts
git commit -m "test(orchestrator): guard execution boundary classes"
```

### Task 6: Run real-provider canaries and fix only reproduced failures

**Files:**
- Modify: `services/orchestrator/test/live/flagship-build.test.ts`
- Modify as evidence requires: files owning the classified root cause
- Append only: `docs/evidence/flagship-runs.jsonl`

**Interfaces:**
- Produces: declared `FLAGSHIP_PROVIDER_ELIGIBILITY` table covering every eligible existing provider.
- Preserves: `FlagshipFailureReason` classifications and append-before-assert behavior.

- [ ] **Step 1: Declare provider eligibility structurally**

Replace the private candidate array with a table whose entries state provider id, real-run eligibility, and whether live model discovery is required. Assert table coverage against the existing provider registry and explicitly exclude ineligible local/custom routes with a reason. Include existing `deepseek` and `opencode-zen`; this does not add a provider.

- [ ] **Step 2: Discover a free OpenCode Zen model without exposing credentials**

Hydrate only the existing secrets file into the scoped test process, call the provider's read-only model discovery, and select a free frontier-capable model from the returned ids. Print only provider/model ids and non-secret reachability metadata. Set `OPENCODE_ZEN_MODEL` for the scoped run.

- [ ] **Step 3: Run one canary per provider**

Run with `MORROW_FLAGSHIP_RUNS=1` and `MORROW_FLAGSHIP_PROVIDERS=deepseek,opencode-zen`. Ensure both outcomes append before any assertion. Do not continue to the 10-run batch if either canary fails.

- [ ] **Step 4: Diagnose a failed canary from durable evidence**

Classify it as `artifact_missing`, `artifact_does_not_run`, `contract_violated`, `task_not_completed`, or `harness_error`. Inspect the retained task status, tool ledger, provider usage, finish reason, and workspace artifact. State one root-cause hypothesis, add the smallest failing structural test, implement one fix, and rerun only that provider's canary.

- [ ] **Step 5: Use one paid comparison only when needed**

If a free model repeatedly fails while orchestration invariants hold, select one paid frontier model on the same or another configured provider and run one canary. Treat a paid pass/free failure as model capability evidence; do not weaken completion or contract checks to manufacture free-model passes.

- [ ] **Step 6: Commit each confirmed live root-cause fix separately**

Use `fix(orchestrator): <class-level invariant>` or `fix(provider): <class-level invariant>`. Include its structural test and no unrelated cleanup.

### Task 7: Prove the gate and record the new invariants

**Files:**
- Create: `docs/decisions/0011-terminal-outcomes-and-requirement-enforcement.md`
- Append only: `docs/evidence/flagship-runs.jsonl`
- Modify: `docs/KNOWN_ISSUES.md`
- Modify: `docs/ENGINEERING_LOG.md`

**Interfaces:**
- Consumes: all preceding invariant implementations and stable provider canaries.
- Produces: passing flagship evidence, security/rollback record, and honest unresolved limitations.

- [ ] **Step 1: Run the full live windows**

Run 10 attempts per provider, or enough additional attempts for each latest window to contain 10 results. Preserve every pass and failure in append order.

- [ ] **Step 2: Verify the release gate**

```powershell
pnpm flagship:gate
```

Expected: `Flagship workflow proven` with both DeepSeek and OpenCode Zen at 9/10 or better. If not, return to Task 6; do not edit evidence or lower thresholds.

- [ ] **Step 3: Write ADR 0011**

Record the terminal-outcome coordinator, exact-task cancellation, idempotent close-out, requirement registry, canonical model identity, security impact, failure behavior, and rollback. Cite the real run window and its classified failures.

- [ ] **Step 4: Update issue history honestly**

Move only currently reproduced-and-fixed entries from `docs/KNOWN_ISSUES.md` to `docs/ENGINEERING_LOG.md`. Leave unverified or unresolved entries in place and state what remains unproven.

- [ ] **Step 5: Run all repository checks without relying on stale cache**

```powershell
pnpm check
pnpm test --force
git diff --check
pnpm flagship:gate
```

Expected: every command exits 0 and the final gate prints the two-provider passing verdict.

- [ ] **Step 6: Perform explicit security review**

Review credential flow, provider external data, cancellation scope, terminal reconciliation, requirement enforcement, continuation persistence, diagnostic exports, and unattended retries. Confirm no secret value or raw reasoning appears in `git diff`, test output, task events, or evidence JSONL.

- [ ] **Step 7: Commit evidence and decisions**

```powershell
git add docs/decisions/0011-terminal-outcomes-and-requirement-enforcement.md docs/evidence/flagship-runs.jsonl docs/KNOWN_ISSUES.md docs/ENGINEERING_LOG.md
git commit -m "docs: record proven real-task reliability"
```

- [ ] **Step 8: Prepare review evidence**

Report exact commands, pass counts, provider/model ids, failure classifications, security review result, rollback notes, and any remaining unproven task class. Do not merge the security-sensitive change without a separate reviewer.
