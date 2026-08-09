# Reliability Baseline and DeepSeek Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the two diagnosed runtime fixes, prove the current flagship-web evaluator is calibrated, and produce one correctly classified DeepSeek `deepseek-v4-flash` canary before beginning a streak.

**Architecture:** Preserve append-only execution and evidence records. Repair only the provider-projection and cached-observation boundaries already demonstrated by live failures, verify the committed supervised-process evaluator contract, then run one serialized canary in a disposable workspace. Any canary failure stops the package and becomes the input to a new bounded repair plan.

**Tech Stack:** TypeScript 5.9, Vitest 4, SQLite, Morrow provider/runtime contracts, Playwright, pnpm, PowerShell.

## Global Constraints

- Work only in `C:\Users\aidan\OneDrive\Documents\Morrow\Morrow\.worktrees\flagship-web-v1` on `codex/flagship-web-v1`.
- Preserve the four pre-existing uncommitted reliability files and unrelated user work.
- Default tests must not call real providers. Only Task 3 is live and explicitly opts in.
- Live attempts are serialized and use disposable workspaces; no parallel flagship runs.
- Use DeepSeek `deepseek-v4-flash` for Task 3.
- Do not inspect, print, copy, or modify credentials.
- Do not edit or remove existing `docs/evidence/flagship-runs.jsonl` rows; append through the production helper only.
- Do not weaken assertions, evidence requirements, safety policy, timeouts, or completion criteria to obtain a pass.
- Changes to provider requests, context/memory, terminal behavior, or completion require independent security review before integration.
- Workers do not stage, commit, push, merge, or edit `agent_docs/project_progress.md` or `agent_docs/latest_session_work.md`.

---

### Task 1: Integrate cached-observation and compaction-headroom fixes

**Files:**
- Modify: `services/orchestrator/src/execution/agent.ts`
- Modify: `services/orchestrator/src/execution/provider-projection.ts`
- Test: `services/orchestrator/test/live-loop-performance-conformance.test.ts`
- Test: `services/orchestrator/test/provider-projection.test.ts`

**Interfaces:**
- Consumes: `toolCallSignature`, `toolResultBytesBySignature`, `ProgressEpoch.recordObservation`, `admitProviderRequest`, `measureProviderRequest`.
- Produces: repeated successful observations reuse cached results without incrementing the progress epoch; compacted provider envelopes leave input-token headroom below `thresholdTokens` when the newest raw group is the avoidable pressure source.

- [ ] **Step 1: Audit the existing regression diff against the two recorded failures**

Confirm the implementation preserves this ordering in `agent.ts`:

```ts
const duplicateBytes = repeatedTool
  ? toolResultBytesBySignature.get(toolSignature)
  : undefined;

if (OBSERVATION_TOOL_NAMES.has(tc.name) && duplicateBytes === undefined) {
  observationRecord = progressEpoch.recordObservation(tc.name, args);
}
```

Confirm `provider-projection.ts` compacts the newest batch when the projected request is admitted but still meets or exceeds its soft threshold:

```ts
if (!admission.ok || admission.measurement.inputTokens >= thresholdTokens) {
  envelope = {
    ...input.envelope,
    messages: [...system, checkpointMessage(input.checkpoint), compactLatestBatch(groups)],
  };
  admission = admitProviderRequest(envelope, input.resolution);
}
```

Do not broaden the change to command policy, checkpoint semantics, or recovery prompts in this task.

- [ ] **Step 2: Validate the captured red evidence**

Review the existing regression names and the main-orchestrator evidence from the originating red runs. The cached-read regression failed before the `duplicateBytes` ordering change because the task became interrupted with `observation_epoch_exhausted`. The compaction regression failed before the projection change with:

```text
expected 97031 to be less than 89243
```

Confirm these assertions encode the two defects without weakening prior coverage:

```ts
expect(readCalls).toHaveLength(4);
expect(task?.status).toBe("completed");
expect(result.admission.measurement.inputTokens).toBeLessThan(result.thresholdTokens);
expect(nextTurn.compacted).toBe(false);
```

- [ ] **Step 3: Restore the fixes and run the focused green gate**

Run the focused command against the intended working diff:

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/live-loop-performance-conformance.test.ts test/provider-projection.test.ts
```

Expected: both files pass with zero failures.

- [ ] **Step 4: Run the adjacent continuity regression gate**

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/checkpoint-rollover.test.ts test/segmented-agent.test.ts test/adaptive-budget.test.ts test/agent-completion-gate.test.ts
```

Expected: all selected files pass with zero failures.

- [ ] **Step 5: Run package verification**

```powershell
pnpm --filter @morrow/orchestrator check
pnpm --filter @morrow/orchestrator test
git diff --check
```

Expected: TypeScript exits 0; the complete orchestrator suite reports zero failures; diff check emits no errors.

- [ ] **Step 6: Return the implementation report**

Report exact changed files, red/green evidence, focused and full commands with counts, remaining risks, and whether the diff should be accepted unchanged. Do not commit.

### Task 2: Independently calibrate the current flagship-web evaluator

**Files:**
- Inspect: `services/orchestrator/src/acceptance/flagship-runner.ts`
- Inspect: `services/orchestrator/src/acceptance/flagship-web.ts`
- Inspect: `services/orchestrator/src/acceptance/flagship-gate.ts`
- Test: `services/orchestrator/test/flagship-web.test.ts`
- Test: `services/orchestrator/test/flagship-build.test.ts`
- Inspect: `services/orchestrator/test/live/flagship-build.test.ts`
- Inspect: `docs/evidence/flagship-runs.jsonl`

**Interfaces:**
- Consumes: `isPreGenerationHarnessFailure`, `runFlagshipScenario`, `verifyFlagshipWebArtifact`, task-owned `ProcessRecord`, `appendFlagshipRun`, `evaluateFlagshipGate`.
- Produces: an evidence-backed decision that the current evaluator correctly recognizes direct and package-script supervised servers, requires inspection/browser/cleanup, and appends every live outcome before assertions.

- [ ] **Step 1: Map the four existing web failures to current predicates**

For each `flagship-web-v1` evidence row, identify the current predicate that would classify it. Confirm the latest historical failure predates commit `3e08bb1` and that the current evaluator recognizes a task-owned direct Node server by its persisted `processId`, not by assuming `pnpm start`.

- [ ] **Step 2: Run focused evaluator tests**

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/flagship-web.test.ts test/flagship-build.test.ts test/agent-background-process.test.ts
```

Expected: all selected tests pass, including `accepts a task-owned server started directly through the supervisor` and the required stop/inspection/browser failures.

- [ ] **Step 3: Audit classification and append ordering**

Verify these invariants directly:

```ts
isPreGenerationHarnessFailure("failed", 0, 0) === true;
isPreGenerationHarnessFailure("failed", 1, 0) === false;
isPreGenerationHarnessFailure("failed", 0, 1) === false;
```

Confirm `appendFlagshipRun(logPath, run)` occurs before live assertions and `evaluateFlagshipGate` excludes only `harness_error` from scorable failures.

- [ ] **Step 4: Return an independent calibration verdict**

Return `CALIBRATED` only if current source and focused tests support the verdict. Otherwise return `DEFECT` with the exact predicate, evidence row, missing regression, and smallest proposed edit surface. Do not edit production or evidence in this task.

### Task 3: Run and classify one DeepSeek flagship-web canary

**Files:**
- Append-only output: `docs/evidence/flagship-runs.jsonl`
- Retained failure workspace: system temporary directory printed by the live runner, only when the run fails

**Interfaces:**
- Consumes: the verified Task 1 runtime, Task 2 `CALIBRATED` verdict, configured DeepSeek provider, `MORROW_FLAGSHIP_PROVIDERS`, `MORROW_FLAGSHIP_SCENARIO`, and the production live runner.
- Produces: exactly one new `flagship-web-v1` DeepSeek evidence row and a primary classification for the next package decision.

- [ ] **Step 1: Confirm preconditions without inspecting credentials**

Require a clean Task 1 focused/full gate, a Task 2 `CALIBRATED` verdict, no active flagship process, and the current four reliability files committed by the main orchestrator. Do not start if any precondition is absent.

- [ ] **Step 2: Run exactly one serialized canary**

```powershell
$env:MORROW_LIVE_FLAGSHIP='1'
$env:MORROW_FLAGSHIP_PROVIDERS='deepseek'
$env:MORROW_FLAGSHIP_SCENARIO='flagship-web-v1'
$env:MORROW_FLAGSHIP_RUNS='1'
pnpm flagship:run
```

Expected: the command invokes only DeepSeek's configured default `deepseek-v4-flash`, appends exactly one evidence row, and prints the retained disposable workspace path.

- [ ] **Step 3: Validate the appended evidence**

Confirm the new row has `mode: "real"`, `providerId: "deepseek"`, `model: "deepseek-v4-flash"`, a non-empty `runId`, task disposition, tool/usage counts, wall-clock duration, and either:

```ts
{ passed: true, failureReason: null, failureDetail: null, artifactSha256: string }
```

or a non-empty classified `failureReason` and `failureDetail` with the failed workspace retained.

- [ ] **Step 4: Stop or advance**

If the canary passes, record the baseline and create the next plan for the serialized DeepSeek streak. If it fails, stop immediately, preserve the workspace and row, classify it using the design taxonomy, and create one bounded deterministic repair task. Do not launch a second live run in this package.
