# Real-task reliability design

**Status:** Design approved; written specification pending user review

**Date:** 2026-08-02

**Branch:** `codex/reliable-task-completion`

## Objective

Make Morrow's existing flagship claim evidence-backed:

> Give Morrow a real task and it finishes correctly, every time.

The release gate remains the existing contract in
`services/orchestrator/src/acceptance/flagship-gate.ts`: two different real
providers must each pass at least 9 of their most recent 10 runs of the
flagship application-building workflow. The gate, not the deterministic test
count, decides whether this work is complete.

Every live run is appended to `docs/evidence/flagship-runs.jsonl`, including
failures. Existing entries are never edited or deleted, and mock runs never
count as real evidence.

## Current evidence

- The deterministic suite is green, but the flagship gate is unproven because
  no real-provider runs are recorded.
- DeepSeek and OpenCode Zen are locally configured. OpenCode Zen has no default
  model selected, so its live model catalog must be discovered before its first
  run.
- A documented split-brain path remains: loop escalation can make a mission
  terminal while its runtime and worker task continue executing.
- Read-only denied-tool completion and private provider continuation are already
  implemented in the current checkout and have focused passing tests. They are
  verification targets, not features to rebuild.
- The legacy DeepSeek selections `deepseek-chat` and `deepseek-reasoner` still
  resolve without canonical context metadata, while `deepseek-v4-flash`
  resolves to the advertised capacity.
- Explicit hard requirements are preserved in checkpoints and mission criteria,
  but the ordinary agent loop has no complete deterministic enforcement path
  for prohibitions such as no frontend, no database, or no new dependencies.

## Chosen approach

Use an invariant-first, flagship-driven reliability loop:

1. Close the known lifecycle split before spending heavily on live runs.
2. Run one canary against each configured provider.
3. Classify each failure from durable evidence before changing code.
4. Fix each confirmed defect as a class, with coverage that fails when a new
   participant is added without declaring its behavior.
5. Repeat canaries until stable, then run the full 10-run windows.
6. Stop only when the real-provider gate passes or an external prerequisite is
   honestly documented as blocking it.

Free frontier-capable models are preferred. A paid model may be used when a
free route fails and one paid comparison is needed to distinguish weak-model
behavior from an orchestration defect. Provider selection and cost remain
visible in the append-only run record.

## Terminal outcome invariant

A mission, its runtime, and its authoritative worker task form one terminal
outcome. No component may become terminal while another continues consuming
tools or provider tokens without an explicit, durable close-out in progress.

All paths that can end a mission—normal finalization, cancellation, recovery
exhaustion, repeated tool failure, plan-revision exhaustion, startup recovery,
and service interruption—must pass through one terminal-outcome coordinator.
The coordinator owns these ordered operations:

1. Reserve an idempotent close-out operation.
2. Prevent new provider turns and signal the authoritative task to stop.
3. Preserve the mission's already-selected terminal status; close-out must not
   promote a blocked or failed mission into success.
4. Run executable verification gates once against the artifact that actually
   exists.
5. Persist criterion evidence and an honest result pinned to the existing
   terminal status.
6. Set the mission runtime terminal state and record the terminal event tuple.

Crash recovery resumes the reserved close-out instead of starting a second
one. Repeated calls become no-ops only after the complete durable tuple exists.
Contradictory history remains an integrity error; missing history is repaired
only when the reserved close-out record provides the exact facts needed to do
so. This preserves the current anti-fabrication boundary in
`reconcileTerminalFinalization`.

Structural coverage must enumerate every terminal entry path and assert the
same invariants: no running task, no executing runtime, no further provider
turn, exactly one close-out, evidence attempted once, and a result whose status
matches the mission's terminal status.

## Task completion invariant

The flagship task passes only when both conditions hold:

- the independently scored artifact satisfies its behavioral contract; and
- the authoritative task reaches `completed` with a durable canonical final
  turn.

A correct artifact followed by aimless inspection is a completion-control
failure, not a successful run and not an artifact failure. The first live
canaries determine whether this reproduces on frontier-capable models.

If it reproduces, completion logic may close after deterministic delivery and
verification evidence proves every applicable requirement and there is no
outstanding failed mutation or verification. It must not infer success merely
from file existence, model narration, elapsed turns, or a weak heuristic.
Stall recovery remains bounded, but it must distinguish productive verification
from repeated observation and must choose truthful completion when all required
evidence is already durable.

The class guard covers task shapes rather than one model: file delivery,
command-line application delivery, frontend delivery, and read-only analysis
must each declare the evidence required for completion. Adding another task
shape without a completion contract fails coverage.

## Hard-requirement invariant

Explicit user constraints become durable requirement nodes before execution.
The first implementation scope is deterministic, high-confidence constraints:

- prohibited deliverable classes, such as no frontend or no database;
- prohibited dependency additions;
- allowed-file or required-file boundaries;
- required commands or verification named by the user; and
- explicit “do not”, “never”, “must”, and “only” statements that map to an
  observable workspace or tool action.

Requirement enforcement occurs at three boundaries:

1. **Before action:** reject a tool call that directly contradicts a known
   prohibition and return structured corrective feedback to the model.
2. **After mutation:** derive observations from the actual diff, manifest, and
   tool ledger; mark contradicted requirements with evidence.
3. **Before completion:** refuse full completion while any authoritative
   requirement is contradicted or unevaluated.

The system does not pretend to understand arbitrary prose perfectly. A
constraint that cannot be mapped deterministically remains visible as
unevaluated and prevents an unqualified success claim. Requirement kinds live
in one registry with evaluator and enforcement declarations. Coverage fails
when a new kind is added without both behavior and tests.

## Model identity invariant

Every provider-selected model id resolves to one canonical metadata identity
before context admission, capability checks, reasoning translation, pricing,
or picker display calculations.

Legacy selections may preserve their user-facing id and mode semantics, but
must point at a canonical model for shared facts. For DeepSeek,
`deepseek-chat` and `deepseek-reasoner` inherit capacity from the canonical
V4 model while retaining their non-thinking and thinking behavior
respectively.

A catalog-wide guard iterates every built-in id and alias. Each must either
resolve to a canonical entry or carry a complete, explicitly independent
metadata contract. Alias cycles, cross-provider aliases, and missing canonical
targets fail deterministically.

## Provider continuity and read-only behavior

Provider continuation remains private protocol state. It may be persisted and
replayed only when its provider, model, protocol, endpoint identity, and route
fingerprint match. It is never displayed, placed in task events, or included in
diagnostic exports.

A tool denied solely because the current mode forbids it remains a structured
constraint, not a fatal task failure. Existing behavior is retained and
covered across every tool profile so future execution tools cannot bypass the
rule or accidentally turn a valid read-only result into `interrupted`.

## Live-run procedure

1. Hydrate provider configuration through Morrow's existing secrets boundary
   without printing values.
2. Discover OpenCode Zen models and select a free frontier-capable model. Use
   DeepSeek's configured free model for the other route.
3. Run one flagship canary per provider and append both outcomes before making
   assertions.
4. For every failure, inspect the preserved workspace, task events, provider
   usage, tool ledger, finish reason, and terminal state. Record one root-cause
   hypothesis and test the smallest change.
5. Add a failing structural test, implement the root fix, and rerun the canary.
6. Once canaries are stable, run enough attempts to give each provider a
   10-result current window.
7. If a free model fails in a way attributable to model capability, run a paid
   frontier model once as a controlled comparison before changing orchestration
   behavior.

The live harness must accept all explicitly supported flagship providers
through a declared capability table. A newly supported provider cannot silently
be excluded from or admitted to the gate.

## Failure handling

- Provider authentication, rate limits, timeouts, truncation, malformed tool
  calls, unsupported capability, and task-control failures keep distinct typed
  classifications.
- A failed live run is evidence and remains in the append-only log.
- Recovery is bounded and strategy-based. Repeating the same operation is not
  progress.
- External provider outages do not become synthetic passes. The run records
  the provider failure and the gate remains unproven until enough genuine runs
  succeed.
- Any close-out failure still stops further paid execution and leaves a durable,
  inspectable terminal outcome or explicit recovery reservation.

## Verification

For each implementation slice:

- reproduce the current behavior;
- add a failing class-level test;
- implement the smallest root-cause fix;
- run the focused tests; and
- run the relevant canary when provider behavior is involved.

Before completion:

```powershell
pnpm check
pnpm test
pnpm flagship:gate
git diff --check
```

Completion additionally requires committed real-provider runs proving at least
9/10 on each of two providers. A green mock suite or a non-passing gate must be
reported as unproven.

## Security and privacy impact

This work touches task execution, model-provider requests, unattended
execution, and private provider continuation, so it requires explicit security
review before merge.

- Credentials remain in the existing owner-readable secrets boundary and are
  never printed, logged, committed, or copied into evidence.
- Live child processes receive only the provider variables required for their
  scoped run.
- Terminal coordination may stop only the exact authoritative task/process; it
  must not use broad process-name termination.
- Requirement enforcement may narrow actions but cannot widen permissions or
  auto-approve an operation.
- Raw provider reasoning remains private and absent from user-visible or
  exported records.

## Rollback

Each invariant lands as a focused Conventional Commit. A slice can be reverted
without editing the append-only live evidence. Reverting code does not revert
historical run results; subsequent runs record the regression honestly.

The terminal coordinator change must be schema-compatible with existing
missions. If a migration is necessary, it is additive and retains the prior
status, runtime, task, evidence, and event records so rollback does not destroy
history.

## Out of scope

No new providers, modes, UI surfaces, memory features, persistent-agent work,
scheduling, MCP expansion, signing, macOS work, or distribution changes are
included. Reliability changes may modify existing provider and execution
boundaries only as required by confirmed flagship failures.
