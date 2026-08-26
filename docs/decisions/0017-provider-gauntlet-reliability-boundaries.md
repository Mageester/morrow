# ADR 0017: Provider Gauntlet Reliability Boundaries

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

The Provider Gauntlet exposed failures at boundaries that had been treated as
implementation details: a CLI timeout could leave durable work and provider
traffic alive, a review could redispatch after its budget, expected fixture
failures were treated as worker failures, and account-discovered models were
not present in every selection surface. Foreground servers also had ambiguous
termination state, while a successful provider that made no workspace progress
could be queried indefinitely.

These failures are especially costly for Morrow because its durable mission
records promise resumability and its local-first posture requires an operator
to understand when external work has stopped.

## Decision

1. The attached CLI is an observer. Mission cancellation is a durable API
   operation that stops the controller, cancels the complete task tree, and
   waits for workers and task-owned processes before returning.
2. Process execution records terminal reason and signal separately from exit
   status. Foreground commands use bounded timeout/tree cleanup; background
   commands have explicit ownership and are reaped at task settlement unless a
   successful task explicitly requested `keepAlive`.
3. `run_command.expectedExitCode` is an explicit assertion, defaulting to zero.
   Evidence retains stdout, stderr, actual/expected exit status, and transport
   termination reason. A matched nonzero assertion is passed evidence and is
   not retried as a worker failure.
4. Review evidence is reconciled before revision dispatch. A later verification
   refreshes a stale review, while an exhausted review budget terminates with
   the reviewer's exact missing evidence and concerns preserved.
5. Provider discovery is persisted once and projected consistently through
   provider status, model status, budget metadata, and model selection. No
   provider credentials or external discovery calls are needed to render the
   cached surface.
6. A successful provider turn that makes no measurable artifact, command,
   checkpoint, or verification progress is bounded and reported as a stall.
   Provider transport failures remain distinct from this no-progress guard.
7. Secret-shaped paths remain denied to worker writes. Security fixtures are
   provisioned externally in an isolated workspace and may be tested, but the
   worker cannot create or mutate them through file tools.

## Consequences

Attached cancellation can take longer than the CLI deadline because it waits
for cleanup; this is intentional and avoids an ambiguous timeout. A hard
process kill can still prevent graceful cleanup, so startup reconciliation and
the durable audit remain necessary. `keepAlive` is deliberately narrow: it is
available only for an explicitly requested successful server workflow and is
never a way for an aborted task to retain a child.

The account model catalogue is now larger and may include provider-reported
models with unknown capabilities. The picker labels those facts as unknown
rather than inventing metadata, preserving provider choice without weakening
route validation or local-only privacy.

## Verification

Regression coverage spans mission/controller cancellation races, process
timeouts and descendant cleanup, expected exit codes 0–4, review refresh and
budget exhaustion, provider discovery cache/restart projections, non-TTY help,
bounded no-progress loops, and isolated synthetic secret fixtures.
