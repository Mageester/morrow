# Agent Loop Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete cognitive babysitting from Morrow's normal agent path while preserving objective security, durability, provider, context, cancellation, budget, and Mission Guardian invariants.

**Architecture:** Simplify `executeAgentChatTask` in place around the existing durable provider projection and tool executor. Exact repeat handling becomes durable model-visible advice; no parallel loop, replacement mega-abstraction, or model-family branch is introduced.

**Tech Stack:** TypeScript, Node.js, SQLite repositories, Vitest, pnpm monorepo, Morrow local web UI.

## Global Constraints

- Use the current uncommitted working tree as the baseline; do not restart from committed `HEAD`.
- Preserve the uncommitted provider capability, canonical request/context, typed error, and stream-normalization work.
- Protect unrelated UI/CLI edits and stage only owned files or hunks.
- Workers do not change Git state or `agent_docs/project_progress.md` / `agent_docs/latest_session_work.md`.
- Apply TDD: each behavioral production change requires a failing regression observed before implementation.
- No model-family-specific behavior, new global state machine, parallel simple loop, hidden threshold increase, or weakened assertion.
- Real provider/UI runs are serialized and never print or persist credentials.

---

### Task 1: Remove mission-level behavioral control and add advisory exact-repeat context

**Files:**
- Modify: `services/orchestrator/src/execution/agent.ts`
- Modify: `services/orchestrator/src/execution/loop-detector.ts`
- Delete if no objective-invariant caller remains: `services/orchestrator/src/execution/progress-epoch.ts`
- Delete if no objective-invariant caller remains: `services/orchestrator/src/execution/convergence-guard.ts`
- Modify: `services/orchestrator/test/agent-loop.test.ts`
- Modify: `services/orchestrator/test/harness-correction.test.ts`
- Modify: `services/orchestrator/test/live-loop-performance-conformance.test.ts`
- Modify or delete obsolete focused tests: `services/orchestrator/test/loop-detector.test.ts`

**Interfaces:**
- Consumes: `toolCallSignature(toolName: string, args: unknown): string`, durable `chatMessages`, persisted tool result text, existing task event writer.
- Produces: provider-neutral exact-repeat advisory messages that are persisted/model-visible and never produce mission interruption.

- [ ] **Step 1: Write failing hot-path regressions**

Add tests that execute at least four identical successful reads and four identical successful writes, then return a final answer. Assert the task completes, every requested tool call is represented durably, and no event/outcome has reason `loop_stalled`, `no_progress`, `observation_epoch_exhausted`, or `strategy_change_required`. Assert the third exact call causes a model-visible reminder and a later reminder includes the prior durable result or artifact reference.

- [ ] **Step 2: Run the focused regressions and capture RED evidence**

Run:

```bash
pnpm --filter @morrow/orchestrator exec vitest run test/agent-loop.test.ts test/harness-correction.test.ts test/live-loop-performance-conformance.test.ts --reporter=verbose
```

Expected: the new repeated-write case interrupts with the existing loop/convergence behavior or lacks the required advisory projection.

- [ ] **Step 3: Delete behavior-supervising state and transitions**

Remove progress-epoch execution bounds, convergence snapshots/decisions, generic `noProgressTurns`, post-delivery read allowances, loop-stalled checkpoint/interruption, behavioral `strategy_change_required`, and their progress-warning emissions from `executeAgentChatTask`. Retain `toolCallSignature` canonicalization and replace detector state with task-local counts used only to schedule advisory messages. Do not alter permission, containment, cancellation, replay-idempotency, provider/context, explicit-budget, or Guardian branches.

- [ ] **Step 4: Persist and project repeat advice**

At exact reminder points, append provider-neutral context through the existing durable/model-visible message path. The first reminder says the exact call repeated and directs inspection of the prior result. The stronger reminder includes the prior result text or existing artifact reference. It never rejects the tool, fails a segment, pauses a mission, or resets history.

- [ ] **Step 5: Run focused GREEN and adjacent invariant tests**

Run:

```bash
pnpm --filter @morrow/orchestrator exec vitest run test/agent-loop.test.ts test/harness-correction.test.ts test/live-loop-performance-conformance.test.ts test/agent-security.test.ts test/agent-completion-contract.test.ts --reporter=verbose
```

Expected: all selected tests pass with objective hard-enforcement assertions unchanged.

### Task 2: Make durable tool results authoritative on the next request

**Files:**
- Modify only if required: `services/orchestrator/src/execution/agent.ts`
- Modify: `services/orchestrator/src/execution/provider-projection.ts`
- Modify: `services/orchestrator/test/provider-projection.test.ts`
- Modify: `services/orchestrator/test/execution-continuity.test.ts`
- Modify: `services/orchestrator/test/segmented-agent.test.ts`
- Add: `services/orchestrator/test/agent-tool-result-continuity.test.ts`

**Interfaces:**
- Consumes: `buildProviderProjection`, `projectProviderRequest`, durable provider turns, durable tool calls/results, route-bound continuation state.
- Produces: the next provider request containing each assistant tool request and exact result once, in valid ordering, after ordinary execution, restart, and segment rollover.

- [ ] **Step 1: Write failing reconstruction regressions**

Create full-agent fixtures where `create_file` succeeds, the process restarts or rolls a segment, and the next provider call captures its messages. Assert the captured request includes the completed tool call and successful result exactly once and contains no executable applied-write replay marker or contradictory failure narrative.

- [ ] **Step 2: Run reconstruction tests and capture RED evidence**

Run:

```bash
pnpm --filter @morrow/orchestrator exec vitest run test/agent-tool-result-continuity.test.ts test/provider-projection.test.ts test/execution-continuity.test.ts test/segmented-agent.test.ts --reporter=verbose
```

Expected: at least one new restart/rollover assertion fails if transient `chatMessages` competes with durable projection.

- [ ] **Step 3: Remove competing transient truth**

Make durable provider turns and tool results the only reconstruction source at the request boundary. Preserve provider-private continuation only under its exact route fingerprint. Do not replace successful results with synthetic controller narration. Reuse the baseline canonical request/context/stream seams.

- [ ] **Step 4: Run focused GREEN and ordering/context checks**

Run:

```bash
pnpm --filter @morrow/orchestrator exec vitest run test/agent-tool-result-continuity.test.ts test/provider-projection.test.ts test/execution-continuity.test.ts test/segmented-agent.test.ts test/context-budget.test.ts test/canonical-request.test.ts --reporter=verbose
```

Expected: all selected tests pass and provider message ordering remains valid.

### Task 3: Preserve objective recovery, security, and completion invariants

**Files:**
- Modify tests only unless a deletion exposed a production defect: `services/orchestrator/test/agent-security.test.ts`
- Modify tests only unless required: `services/orchestrator/test/recovery.test.ts`
- Modify tests only unless required: `services/orchestrator/test/provider-fallback.test.ts`
- Modify tests only unless required: `services/orchestrator/test/agent-completion-contract.test.ts`
- Modify tests only unless required: `services/orchestrator/test/mission-controller.test.ts`

**Interfaces:**
- Consumes: existing approvals, containment, tool validation, execution lease, cancellation, typed provider retry/overflow, explicit budgets, Mission Guardian.
- Produces: evidence that these objective invariants remain hard after behavioral guard deletion.

- [ ] **Step 1: Add or strengthen invariant tests before any necessary production repair**

Cover denied approval, workspace escape, invalid arguments, duplicate side-effect replay, cancellation, explicit turn/tool budget, typed context overflow, bounded provider fallback, and Guardian rejection of missing completion evidence. Each test must assert the durable state and not merely an error string.

- [ ] **Step 2: Run the invariant gate**

Run:

```bash
pnpm --filter @morrow/orchestrator exec vitest run test/agent-security.test.ts test/recovery.test.ts test/provider-fallback.test.ts test/agent-completion-contract.test.ts test/mission-controller.test.ts --reporter=verbose
```

Expected: all pre-existing cases pass; any newly strengthened case must be observed failing before a production repair.

- [ ] **Step 3: Repair only objective-invariant regressions**

If deletion exposed a defect, change the owning security/durability boundary rather than adding a generic progress or reasoning supervisor. Rerun the exact failing test, then the full invariant gate.

### Task 4: Deterministic integration, architecture evidence, and real UI/model trials

**Files:**
- Modify: `docs/decisions/0014-bounded-harness-convergence.md`
- Modify: `docs/architecture.md`
- Modify: `CHANGELOG.md`
- Add: `docs/superpowers/reports/2026-08-15-agent-loop-simplification-evidence.md`
- Append real run records only through the existing harness: `docs/evidence/flagship-runs.jsonl`

**Interfaces:**
- Consumes: verified implementation, current configured providers/models, existing local UI and flagship/live harness.
- Produces: before/after size and behavior evidence plus serialized real-model Activity results.

- [ ] **Step 1: Run deterministic integration gates**

Run sequentially:

```bash
pnpm --filter @morrow/orchestrator check
pnpm --filter @morrow/orchestrator test
pnpm check
pnpm build
```

Record exact counts, exit codes, and any environment limitation. Do not infer live behavior from these gates.

- [ ] **Step 2: Perform security-sensitive diff review**

Review the permission, filesystem, terminal, browser, provider request, continuation, persistence, cancellation, budget, and Guardian boundaries. Require an independent reviewer verdict before live execution.

- [ ] **Step 3: Start the real Morrow UI and run Qwen unchanged**

Use the configured Qwen model and exact approved prompt. Observe the real Activity stream, tool/result ordering, warnings, terminal state, produced website, browser verification, and process cleanup. Preserve redacted task/run IDs and event evidence. Do not print credentials.

- [ ] **Step 4: Iterate on root causes if Morrow still fights Qwen**

For any harness interference, add a failing deterministic reproduction, remove or simplify the owning behavioral mechanism, re-run focused and integration gates, then repeat exactly one serialized Qwen trial. Do not raise thresholds or suppress presentation.

- [ ] **Step 5: Run the same task on other configured real models**

Enumerate configured usable routes without exposing secrets. Run the unchanged website task serially in equivalent isolated fixture workspaces. Record model, tool sequence summary, warnings, terminal outcome, verification, and limitations.

- [ ] **Step 6: Record architecture and rollback evidence**

Document the machinery that existed, deletions, advisory policy, retained hard enforcement and rationale, before/after normal-path line/symbol counts, deterministic results, live Activity results, privacy/security impact, known limitations, and rollback by focused commit reversal.

## Self-review checklist

- Every requirement in the approved design maps to a task above.
- No task creates a second loop, model-family branch, replacement mega-abstraction, or threshold-only workaround.
- The plan distinguishes scripted provider conformance from real UI/model evidence.
- Worker edit ownership excludes unrelated dirty UI/CLI/provider work.
- Production changes require observed RED evidence and independent review.
