# Reliability-First Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver durable controller recovery, loss-aware checkpoint rollover, native verified team orchestration, and an attributable autonomous gauntlet.

**Architecture:** Two disjoint reliability packages stabilize controller and checkpoint contracts in parallel. Native orchestration then consumes those durability contracts through a parent-owned work graph, followed by delegation hardening and an integrated gauntlet.

**Tech Stack:** TypeScript, Node.js, SQLite/better-sqlite3, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-27-reliability-first-architecture.md`

## Global Constraints

- Preserve canonical completion, Guardian, lease fencing, idempotent operation/provider-turn, privacy, permission, and local-first invariants.
- Production behavior changes require a failing test first and an independent Luna Max review.
- Workers do not edit Git state, `agent_docs/project_progress.md`, `agent_docs/latest_session_work.md`, or protected UI paths.
- Deterministic gates require no provider credentials or external network.

---

### Task 1: Durable controller error recovery

**Files:**
- Modify: `services/orchestrator/src/mission/controller-runner.ts`
- Modify only if the durable schema requires it: `services/orchestrator/src/repositories/mission-runtime.ts`, `services/orchestrator/src/database.ts`
- Test: `services/orchestrator/test/mission-controller-restart.test.ts`
- Test: a focused new controller-runner failure test if cohesion warrants it

**Interfaces:**
- Consumes: existing lease fences, controller snapshots, terminal-outcome service, startup reconciliation.
- Produces: durable classified recovery/blocked state for unexpected drive, tick, prepare, and closeout failures; bounded restart-safe retry semantics.

- [ ] Add focused tests proving a non-fencing drive rejection cannot disappear through the log-only handler, preparation failure is not returned as success, retry survives restart without duplicate dispatch, and exhaustion reaches an evidenced blocked/terminal state.
- [ ] Run the focused tests and capture expected RED failures caused by the current log-only/preparation behavior.
- [ ] Implement the smallest durable classification and bounded retry contract inside the owning runner/runtime boundary.
- [ ] Run focused tests, then `pnpm --filter @morrow/orchestrator test -- mission-controller-restart.test.ts mission-accountability-closure.test.ts canonical-completion-invariants.test.ts`.
- [ ] Self-review for fencing, duplicate dispatch, terminal truth, and cancellation regressions; hand off exact evidence for independent review.

### Task 2: Loss-aware checkpoint fidelity

**Files:**
- Modify: `services/orchestrator/src/execution/checkpoint-snapshot.ts`
- Modify only if reconstruction needs an exposed flag: `services/orchestrator/src/repositories/execution-continuity.ts`
- Test: `services/orchestrator/test/execution-continuity.test.ts`
- Test: `services/orchestrator/test/agent-requirement-conformance.test.ts`
- Test: `services/orchestrator/test/checkpoint-rollover.test.ts`

**Interfaces:**
- Consumes: `ExecutionCheckpointSnapshot`, persisted checkpoint rows, restart reconstruction.
- Produces: bounded deterministic semantic recovery capsule and explicit loss/compaction metadata.

- [ ] Add oversized fixtures proving objective, requirements, criteria, decisions, completed work, changed files, failures, approvals, routing, and pending work remain recoverable after bounding and restart.
- [ ] Run focused tests and capture RED evidence that the current fallback empties essential categories.
- [ ] Implement deterministic per-category compaction/digests without changing raw durable audit rows or provider segment ordering.
- [ ] Run focused tests, then `pnpm --filter @morrow/orchestrator test -- execution-continuity.test.ts agent-requirement-conformance.test.ts checkpoint-rollover.test.ts segmented-agent.test.ts`.
- [ ] Self-review exact byte bounds, deterministic output, malformed legacy data, and minimum-context behavior; hand off evidence for independent review.

### Task 3: Durable native team work graph

**Files:**
- Create or modify focused modules under `services/orchestrator/src/mission/` and `services/orchestrator/src/repositories/` after Tasks 1–2 publish stable interfaces.
- Modify schema/contracts only where required: `services/orchestrator/src/database.ts`, `packages/contracts/src/index.ts`
- Test: new cohesive orchestration graph tests plus relevant `services/orchestrator/test/subagents.test.ts`

**Interfaces:**
- Consumes: controller retry/restart disposition and checkpoint semantic capsule.
- Produces: parent-owned work units with stable idempotency keys, ownership, dependencies, bounded concurrency, terminal dispositions, review state, import state, and synthesis state.

- [ ] Add RED tests for deterministic decomposition, duplicate suppression, atomic bounded admission, restart-safe ownership, dependency release, and no duplicate fan-in.
- [ ] Implement the smallest repository/service boundary for an explicit durable work graph; preserve existing `ask_teammate` dispatch behavior.
- [ ] Add RED tests requiring canonical verified child evidence and an independent reviewer before import; reject running, failed, blocked, stale, or self-reviewed children.
- [ ] Implement deterministic terminal import and once-only synthesis after all required children resolve.
- [ ] Run focused orchestration, subagent, teammate delegation, mission restart, and canonical completion regressions; hand off evidence for security-aware independent review.

### Task 4: Delegation admission and handoff hardening

**Files:**
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/src/mission/task-dispatcher.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify focused repositories where atomic transactions belong.
- Test: `services/orchestrator/test/subagents.test.ts`, `services/orchestrator/test/teams-and-delegation.test.ts`, and a focused race test.

**Interfaces:**
- Consumes: Task 3 work-unit identity and child verification/import contract.
- Produces: atomic admission, required idempotency keys, durable ownership, bounded concurrency, and verified terminal handoffs.

- [ ] Add concurrent RED tests proving count-then-start can over-admit and retrying REST spawn can duplicate a child.
- [ ] Add RED tests rejecting caller-asserted evidence, non-terminal children, and unverified/canonically stale handoffs.
- [ ] Move admission into one transactional repository operation and require stable spawn idempotency while preserving compatible inspect-workspace behavior.
- [ ] Bind handoff/import to authoritative terminal child evidence and run all delegation/security regressions.
- [ ] Hand off concurrency and trust-boundary evidence for independent adversarial review.

### Task 5: Attributable integrated autonomy gauntlet

**Files:**
- Create focused acceptance modules under `services/orchestrator/src/acceptance/`.
- Create focused tests under `services/orchestrator/test/`.
- Update `docs/ACCEPTANCE.md` and architecture/ADR documentation only after verified behavior settles.

**Interfaces:**
- Consumes: Tasks 1–4 production boundaries.
- Produces: deterministic phase-attributed report for controller, checkpoint, delegation, verification, and efficiency gates.

- [ ] Construct a fresh-fixture scenario that forces controller error/restart, oversized rollover, duplicate spawn attempts, parallel child success/failure/revision, independent review, false completion, and deterministic synthesis.
- [ ] Assert stable mission/work-unit identities, zero duplicate effects/imports/synthesis, preserved semantic capsule, Guardian-gated completion, and SQLite integrity.
- [ ] Record phase counters for reads, unchanged command reruns, duplicate work, provider turns, tool calls, recoveries, rollovers, and reviews; fail the owning phase with exact evidence.
- [ ] Run the focused gauntlet, sustained-autonomy, canonical completion, restart, delegation, and checkpoint suites.
- [ ] Run repository type checks and the strongest practical deterministic regression suite; retain logs under `/tmp` and hand off for final broad Luna review.
