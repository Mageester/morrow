# ADR-0014: Bounded harness convergence and explicit whole-file writes

Status: accepted

Date: 2026-08-14

## Context

The execution loop could spend dozens of provider turns rewriting a small set
of files without creating a new artifact, changing a requirement, verifying the
result, or changing its diagnosis. Existing repeat observations were advisory,
so the task did not pause with a durable explanation. The `create_file` path
also changed an existing-file call into a patch/edit operation, which made a
successful caller action look like a `target_exists` failure and encouraged
provider retries.

## Decision

Morrow keeps the authoritative provider-turn ledger as the execution source of
truth and adds a separate, durable convergence guard. The guard records:

- exact tool-call signatures;
- canonical operation identity as tool family, normalized target, and operation
  class; and
- observable progress such as new artifacts, requirement changes, verification,
  diagnostic changes, and application milestones.

Failed argument or permission calls do not establish write churn. Legitimate
iterative edits can continue when they deliver verification or other observable
progress. Repeated successful writes without such progress reach a bounded
threshold, persist a checkpoint, emit a structured `loop-stalled` warning, and
pause with a resumable task state.

`create_file` is an explicit whole-file overwrite operation for both absent and
existing regular files. It uses an expected-content fence, same-directory
temporary writes, atomic replacement, content-hash backups for existing files,
and idempotent replay detection. It never synthesizes a patch or emits a
`target_exists` strategy switch. Security path containment, denied-name checks,
approval records, cancellation, and process cleanup remain on the existing
execution boundary.

Provider fallback is bounded and reports omitted candidates as durable evidence;
tool-only turns remain valid provider responses, while empty responses retain a
bounded retry policy and explicit incomplete termination.

### Externalized reads remain authoritative

The artifact store remains the byte-boundary for oversized tool results, but a
successful externalized `read_file` is projected differently from a generic
command result. The model receives an exact bounded content prefix, the file's
range metadata, and an explicit next `read_file` action when more bytes remain.
It does not need to inspect Morrow's persistence layer to decide whether the
file read succeeded or whether the displayed content is usable. A bounded
`read_artifact` page follows the same rule: its content is projected directly
and cannot recursively turn into another artifact pointer.

## Consequences

Tasks stop early and explain the reason when they are not converging, rather
than consuming an unbounded provider budget. A resumed task sees the advisory
and checkpoint counters without replaying completed writes. Existing-file
updates have one predictable operation class and retain undo evidence. The
guard is intentionally conservative: read-only repetition remains advisory,
and provider/live-network success still requires separate runtime evidence.

The focused harness regressions and the fresh Pulse acceptance run cover the
pathological pause, resume projection, direct overwrite, provider cap, source
verification, real browser interaction, responsive screenshots, and supervised
server shutdown.

The read projection is reversible without a data migration: reverting the
projection code restores the previous model-facing representation while the
complete `result_json` and artifact rows remain intact. The behavioral risk of
that rollback is renewed model confusion or duplicate inspection, not loss of
the captured file bytes.
