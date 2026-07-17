# Packaged Acceptance Foundation Design

## Scope

This slice adds one truthful, consumer-facing acceptance path and no broader
autonomy program. It provides:

- `morrow acceptance run` for the versioned foundation smoke scenario;
- `morrow acceptance resume <run-id>` for interruption-safe continuation;
- `morrow acceptance report <run-id>` for regenerating and locating reports;
- a disposable Git fixture with a recorded starting commit;
- durable atomic run state and an append-only evidence ledger;
- JSON and Markdown reports using PASS, FAIL, BLOCKED, NOT RUN, and
  INCONCLUSIVE;
- one packaged smoke that invokes Morrow through its compiled CLI and persists
  product task events/evidence.

This slice does not add real-model matrices, provider failover, browser/vision,
automatic Cortex memory, automatic skill creation, or the 15-task autonomy
suite. It performs no metered model call.

## Consumer path

The command is registered in the existing CLI command table. The installed
launcher already delegates unknown product commands to the compiled CLI, so no
launcher template changes are required. The package smoke starts with the
packaged `morrow.cmd acceptance run` entrypoint. The acceptance command then
spawns the same packaged CLI executable with an argument array (never a shell
command) to run the fixture task.

The deterministic scenario uses `MOCK_PROVIDER=true`. The packaged product
still starts its real orchestrator, creates its real SQLite database, registers
the isolated project, runs its normal task/execution path, invokes the real
workspace-contained `read_file` tool, and persists task events and evidence.
Only provider output is deterministic. This is a foundation proof, not a claim
that a real model can repair code.

## Run directory and isolation

Each run owns this directory below the invoking CLI's `MORROW_HOME`:

```text
acceptance/runs/<run-id>/
  state.json
  evidence.jsonl
  report.json
  report.md
  artifacts/
  fixture/
  product-home/
```

The fixture directory is created by the harness, initialized as a real Git
repository, populated with small immutable scenario files, committed, and its
starting SHA recorded before Morrow launches. All child product state is rooted
at `product-home`; the child receives no parent provider credentials. The
runner verifies the fixture and product-home paths are descendants of the run
directory before creating, cleaning, or executing anything.

Successful runs remove the disposable fixture and product home only after
reports are durable. Failed or inconclusive runs retain them for diagnosis.
The evidence and reports never depend on a retained workspace.

## Durable state and resume

`state.json` records schema version, run/scenario identity, lifecycle state,
classification, timestamps, package/product identity, source and fixture Git
fingerprints, completed step IDs, recovery count, and relative artifact
references. Writes use a sibling temporary file followed by an atomic rename.

Before each side effect the runner records a step-start event and updates
state. After it succeeds the runner records the step result and atomically
marks the step complete. Resume skips completed idempotent steps. If the
read-only product invocation was interrupted, resume resets the fixture to its
recorded clean starting commit and reruns that step, recording a recovery
event. A terminal run can be resumed safely to regenerate reports without
replaying product work.

## Evidence and classification

`evidence.jsonl` is append-only. Every entry has a stable ID, sequence,
timestamp, step, kind, status, summary, and optional relative artifact
reference. Command execution uses exact executable/argument arrays and bounded
stdout/stderr artifacts. Reports include summaries and references, not raw
unbounded logs.

The scenario is PASS only when all of these are directly verified:

1. fixture path is contained within the run root;
2. fixture is a clean Git repository and its starting SHA is recorded;
3. packaged/compiled Morrow exits successfully through the consumer CLI path;
4. the child product database exists;
5. persisted task events and workspace evidence are observed through a
   consumer-facing JSON command;
6. the fixture Git commit and invoking source-worktree fingerprint are
   unchanged;
7. JSON and Markdown reports are generated;
8. the report leak scan finds no seeded secret or credential-like value.

An observed incorrect result is FAIL. A named unavailable external condition
is BLOCKED. An intentionally skipped scenario is NOT RUN. Missing or
contradictory evidence is INCONCLUSIVE. Only PASS satisfies the scenario.

## Redaction and targeted security controls

All persisted strings pass through a shared redactor before entering evidence
or reports. It masks common credential assignments, bearer tokens, private-key
blocks, and a seeded canary secret. Reports use relative artifact paths and do
not include environment dumps, provider configuration, absolute user paths, or
raw SQLite contents.

Process execution uses `spawn`/`execFile` with `shell: false`, fixed
executables, fixed scenario arguments, a bounded timeout, and a minimal child
environment. Git operations are an allowlisted sequence scoped to the fixture.
No push, remote, deployment, package purchase, credential mutation, or
destructive command is available in this scenario.

## Testing

Tests cover status parsing, redaction, containment, atomic/resumable state,
fixture Git initialization, truthful classification, report generation,
command routing, and a compiled/packaged smoke. The smoke captures the source
Git status and commit before and after execution and inspects the resulting
evidence/report artifacts. Full repository checks are run afterward; unrelated
pre-existing failures are reported rather than concealed.

## Privacy and rollback

The harness uses only local filesystem, Git, a loopback service, and the mock
provider. It adds no telemetry or external inference. Removing the CLI command
and `apps/cli/src/acceptance` module removes the feature; run artifacts are
ordinary local files under `MORROW_HOME/acceptance` and are never uploaded.
