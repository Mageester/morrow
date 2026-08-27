# Reliability-First Architecture Sprint

## Objective

Make Morrow materially more durable and independently verifiable across controller failures, oversized context rollover, native multi-agent execution, and autonomous acceptance runs without weakening its existing completion, Guardian, restart, rollover, idempotency, or privacy protections.

## Existing invariants to preserve

- Mission completion requires the authoritative canonical answer, durable successful verification, resolved blockers/failures, satisfied requirements, and Guardian/review authorization.
- Controller ownership is fenced by durable leases and completed operations are idempotent across restart.
- Provider turns and context segments remain durable and restart-safe.
- `ask_teammate` retains its existing durable idempotency and execution-policy binding.
- Local-first provider choice, permission boundaries, evidence privacy, and protected UI work remain unchanged.

## Architecture

### Controller recovery

`MissionControllerRunner` must convert unexpected drive, tick, preparation, and closeout failures into durable classified state. Recoverable failures receive a bounded, restart-safe retry disposition; exhausted or non-recoverable failures produce an explicit blocked/terminal outcome with evidence. No active driver may disappear after a log-only rejection, and preparation failure must never masquerade as successful preparation.

### Checkpoint fidelity

Oversized execution checkpoints may compact verbose history, but must retain a bounded semantic recovery capsule containing the objective, hard requirements and criteria, decisions, completed work, changed files, unresolved failures, recovery attempts, approvals, routing, acceptance criteria, and next pending work. If a category cannot fit verbatim, the snapshot must record a loss-aware deterministic digest rather than silently emptying it. Restart reconstruction must expose whether any detail was compacted.

### Native team orchestration

Native orchestration uses a durable parent-owned work graph. Decomposition produces uniquely owned, non-duplicated work units; admission is atomic and bounded; spawn is idempotent; children have durable owner/profile/policy identity; only terminal, canonically verified child results can be imported; review is independent of the producing child; and deterministic fan-in synthesizes results once all required children reach terminal dispositions. Restart must not duplicate children, imports, reviews, or synthesis.

### Gauntlet and efficiency

The integrated deterministic gauntlet must attribute failures to controller recovery, checkpoint fidelity, delegation, verification/false completion, or tool efficiency. It forces failures, interruption/restart, multiple rollovers, duplicate requests, child rejection/revision, and final synthesis. Efficiency evidence records repeated reads, unchanged command reruns, duplicate work units, provider turns, and tool calls per phase; budgets fail with attributable diagnostics rather than a single opaque status.

## Verification and review

Every behavior change follows red-green-refactor, receives focused tests and an independent Luna Max review, repairs substantive findings, and runs relevant regression suites. Security-sensitive delegation and completion changes receive an explicit adversarial review. Coherent verified units are committed separately. The strongest practical integrated suite runs after all packages settle.

## Scope boundaries

- Do not modify prototype or protected web surfaces named in `agent_docs/project_structure.md`.
- Do not introduce remote services, telemetry, new hosted dependencies, or credential requirements into deterministic tests.
- Do not redesign working completion, Guardian, provider-turn, or teammate-policy boundaries without a reproducing conflict.
