# Provider Gauntlet Reliability and Truthfulness Design

**Date:** 2026-08-25

**Status:** Approved in chat; implementation pending written-plan review.

**Goal:** Make Morrow's durable mission, worker, command, provider, model, and CLI surfaces agree about lifecycle, progress, evidence, and permissions under the Provider Gauntlet scenarios.

## Scope and boundaries

The change stays inside the existing boundaries:

- `apps/cli` owns foreground observation, help routing, and signal handling.
- `MissionControllerRunner` and `TaskRunner` own durable mission/worker cancellation and descendant cleanup.
- `MissionController`, `MissionService`, and Guardian own review admission, evidence freshness, and terminal mission outcomes.
- `run_command`, `runProcessSafe`, and `ProcessSupervisor` own command result and process lifecycle semantics.
- `tools/catalog.ts` and the agent dispatcher own advertised-versus-callable tool behavior.
- `routing/models.ts`, provider discovery persistence, and API projections own the model source of truth.
- The existing permission profile remains authoritative for secret paths and tool access.

No provider-specific workaround, hosted inference path, telemetry, or security exception is introduced.

## Decisions

### 1. Foreground CLI lifetime and durable mission lifetime

An explicit `--detach` is the only foreground CLI path that intentionally leaves a mission running after the CLI exits. A non-detached `build`, `run`, or objective-bearing `mission` command is an observer whose lifecycle is coupled to the mission:

1. After a mission id exists, SIGINT, SIGTERM, or SIGHUP requests mission cancellation.
2. The cancellation API marks the mission terminal before another controller tick may dispatch work.
3. The controller cancels the active task and its persisted descendant tree, waits for all active task promises, and waits for task-owned process cleanup.
4. The CLI waits for the API's terminal projection, renders the cancelled result, and exits with the cancellation status. It never reports a timeout while the mission is still active.

Normal foreground completion still waits for a terminal mission result. Detached execution remains durable and is resumed or inspected with the existing mission commands.

The cancellation fence is implemented at both the durable mission boundary and the in-process runner boundary. This prevents a race in which a controller already inside a dispatch tick creates a worker after a cancellation request.

### 2. Review cycles and evidence freshness

The configured `maxReviewCycles` is an admission limit, not only a service-level validation. The controller snapshot will include the current review count, maximum, review creation time, and latest non-review evidence time.

For a `revisions_required` review:

- If no newer validation evidence exists, the controller may dispatch the bounded revision strategy.
- After a revision worker completes, validation evidence is refreshed and the snapshot is reloaded before any revision worker is dispatched again.
- If newer evidence exists, the controller requests a fresh independent review instead of repeatedly applying the same revision action.
- If `reviewCyclesUsed >= maxReviewCycles`, the controller produces one terminal `revision_limit` outcome with `blocked` mission status. The reason includes the reviewer’s exact `missingVerification` and `concerns`. No review provider call or revision worker is dispatched after this point.

The existing MissionService atomic review reservation and application remain the final write-side guard.

### 3. Expected command exit codes

`run_command` gains an optional integer `expectedExitCode`. Its default is `0`. A command is a passed tool operation when its actual exit code exactly equals the expected code and it did not time out or get cancelled. The result preserves:

- stdout and stderr;
- actual exit code;
- expected exit code;
- expected-versus-actual status;
- termination reason; and
- signal, when the operating system reports one.

An expected nonzero result is passed evidence and is not retried as a failed worker operation. An unexpected result remains a failure and continues through the existing recovery/evidence paths. Mission verification’s existing `expectExitCode` contract is unchanged; the worker-tool field is intentionally named separately and is translated into the same completion-gate semantics.

### 4. Process lifecycle and bounded stalls

All command and background-process paths report one of completed, timed out, cancelled, failed, or signal-killed outcomes with the relevant exit code/signal. POSIX process groups and Windows process-tree termination remain in use.

Task terminal transitions wait for task-owned processes to settle. `keepAlive:true` remains an explicit user request and is not killed by ordinary successful task completion. Cancellation is an explicit stop boundary: it kills every process owned by the cancelled task and its descendants, including keep-alive processes, so a cancelled mission cannot retain background work.

The process registry preserves structured `terminationReason` and `signal` metadata in addition to its existing status/exit-code fields. A timeout may keep the compatibility status `failed`, but it is no longer represented as an unexplained failure or a null/unknown exit.

The foreground command path records a stable command signature. A repeated identical foreground command that times out is stopped at a bounded threshold and reported as a command stall; Morrow does not spawn the same long-running command indefinitely. The result tells the worker to use background mode with an explicit lifecycle if a server is intentional.

### 5. Meaningful progress and provider no-progress behavior

The existing progress snapshot becomes a control signal only for change-oriented agent tasks. Meaningful progress is limited to evidence-backed deltas: a changed workspace artifact, a passed verification, a cleared failure, a validated criterion, a checkpoint, or another existing measurable state change. Read-only tool activity, repeated narration, provider success without an effect, rate limits, billing errors, authentication failures, and other provider errors do not count as progress and are not mislabeled as a Morrow stall.

After three consecutive successful provider turns without meaningful progress on a change-oriented task, Morrow records a clear `no_progress_stall`, checkpoints the task, stops the worker, and returns a terminal mission outcome rather than redispatching it indefinitely. Standalone tasks are interrupted with the same actionable message. Answer-only and read-only tasks are not subject to this change-progress bound.

### 6. Tool catalog conformance

`write_plan` remains available to the agent under its existing read-only permission profile. The catalog, exposed tool definitions, and dispatcher will share a conformance surface so every advertised worker tool is either callable with its declared schema or explicitly marked unavailable. A runtime test will execute `write_plan` through the worker path and verify the durable plan update. No unrelated permission is broadened.

### 7. Provider discovery and model projections

The discovered model repository plus the active catalog is the single source for provider statuses, `/api/models`, `/api/models/budgets`, provider refresh responses, and CLI model JSON. Cached discovery is loaded before projections are served; explicit provider refresh atomically updates the cache and all projections. Provider-reported models remain identifiable as provider-reported and do not inherit unsupported vendor capabilities.

The model list includes configured/discovered TokenRouter and NVIDIA models even when they are absent from the bundled catalog. Unavailable or stale models remain visible with an honest availability reason.

### 8. Non-interactive help and stdin

Help for `providers`, `build`, and `run` is resolved before configuration loading, service startup, or onboarding. It returns successfully in TTY, pipe, and CI-style execution. Prompt helpers guard optional stdin methods such as `ref`, `resume`, `pause`, and `setRawMode` so test doubles and non-TTY streams cannot crash onboarding/help.

### 9. Secret paths and isolated fixtures

The worker continues to reject real secret-like paths, including `.env`, and the rejection remains durable evidence. Tests that need a local secret fixture provision it outside the worker authorization boundary in an isolated temporary workspace before execution. Morrow does not add a path-pattern allowlist or infer that a filename is safe from a test label.

## Data-flow invariants

The implementation must preserve these invariants:

1. A mission reported terminal has no active task, descendant worker, or task-owned process left behind by cancellation; successful detached/keep-alive execution is the only explicit exception to ordinary completion cleanup.
2. A terminal mission has a durable result or a durable close-out error; a CLI cancellation/timeout never silently leaves only a `running` or `reviewing` aggregate.
3. A review cycle is consumed at most once and never begins after the configured budget is exhausted.
4. Evidence status is determined by expected-versus-actual command semantics, not by the assumption that only exit code zero can be correct.
5. Process status, exit code, signal, timeout, and cancellation are not collapsed into `null`/unknown.
6. Provider errors are distinct from no-progress stalls.
7. Secret-like paths remain denied to the worker; externally provisioned test fixtures do not change the production policy.
8. Model availability and metadata are projected from the same cached discovery/catalog inputs across API and CLI surfaces.

## Verification plan

### Mission and review

- Unit-test controller cancellation while a dispatch tick is in flight.
- Test `cancelAndWait` with a parent, child, and grandchild task and assert no active promise remains.
- Exercise the mission cancel API and assert the returned runtime is terminal and the task/process registries are settled.
- Test review budget exhaustion with exact missing evidence and concerns preserved.
- Test stale review evidence followed by later passing validation evidence; assert one fresh review request and no repeated revision dispatch.

### Commands and processes

- Test expected exit codes `0`, `1`, `2`, `3`, and `4`, plus a mismatch.
- Assert stdout, stderr, expected/actual status, exit code, and signal/termination fields, including structured process-registry metadata.
- Test foreground timeout, repeated identical timeout, background server start/stop, cancellation, process-group descendant cleanup, and task-terminal cleanup.
- Assert expected nonzero verification evidence is passed and not retried.

### Agent progress and tools

- Drive a successful mock provider that performs no writes or verification and assert a bounded `no_progress_stall` outcome.
- Drive provider errors/rate limits and assert they remain provider failures.
- Run the advertised-tool conformance test, including a real `write_plan` worker call.

### Discovery, CLI, and security

- Load cached TokenRouter/NVIDIA-style discovery and compare provider status, model list, budgets, refresh result, and CLI JSON.
- Run `providers --help`, `build --help`, and `run --help` with TTY-like and non-TTY stdin.
- Assert real `.env` worker writes remain blocked, while a harness-provisioned isolated fixture can be consumed by a test without a worker path exemption.

### Real-provider order

After local tests pass, use the source CLI in an isolated Morrow home for the low-cost routes in this order: OpenCode `x-preview-f-free`, TokenRouter free, and NVIDIA `nvidia/nemotron-3-ultra-550b-a55b`. Only then run one shared benchmark. Real-provider failures caused by rate limits, billing, authentication, or provider no-progress will be recorded separately from Morrow defects.

## Documentation and rollback

Update `docs/architecture.md`, `docs/TERMINAL.md`, `docs/providers.md`, and `docs/privacy-model.md` for the lifecycle, process, discovery, and fixture boundaries. Add a decision record because the controller/task/process terminal boundary changes.

The rollback is a single revert of the focused commits on `fix/provider-gauntlet`. It restores the previous observer behavior and data projections without deleting migrations or user mission data; any already-terminal missions remain terminal and can be inspected or resumed only through their explicit lifecycle commands.

## Non-goals

- Do not make all provider responses trustworthy merely because they are successful.
- Do not whitelist `.env`, credentials, private keys, or other secret-like paths.
- Do not hide provider rate limits, billing failures, or authentication failures as Morrow bugs.
- Do not add telemetry or route provider payloads through a hosted service.
- Do not redesign the web UI or introduce a new mission persistence model.
