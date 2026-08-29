# Initial Architecture

This document defines the starting boundaries. It is intentionally narrower than the final product.

## System view

```text
Web / Desktop / CLI / Messaging
              │
              ▼
      Morrow Application API
              │
      ┌───────┴────────┐
      ▼                ▼
 Orchestrator       Event stream
      │
      ├── Task planner and checkpoints
      ├── Persistent named agents
      ├── Model router
      ├── Memory service
      ├── Scheduler
      └── Tool permission decisions
              │
              ▼
         Tool Runtime
      ├── Filesystem
      ├── Terminal
      ├── Browser
      ├── Web and APIs
      └── Extension adapters
```

## Repository boundaries

### `apps/web`

Primary product interface. It owns navigation, conversation experience, project views, activity inspection, settings, and customization studio.

### `apps/desktop`

Native packaging and operating-system integration. It must not become a second independent product implementation.

### `services/orchestrator`

Owns tasks, plans, named agents, checkpoints, retries, schedules, budgets, approvals, and event coordination.

`src/runtime/host.ts` is the single composition root for a running Morrow.
Both ways to start the service — the standalone `services/orchestrator`
entrypoint and the CLI's in-process `morrow start` — build the same component
list in the same order and tear it down through one idempotent shutdown. They
had drifted before this existed, and a packaged install ran a shorter runtime
than the standalone one with no way for a user to tell (see
[ADR 0018](decisions/0018-authoritative-runtime-and-skill-lifecycle.md)).

`src/skills/catalog.ts` is the only authority on which skills exist, which are
valid, and which are loadable. The HTTP server, the task runner, and through it
the agent share one instance; the CLI and the web app read and write that state
over the API rather than keeping their own. Skill directories never leave the
service.

`GET /api/health` carries a required `runtime` block describing what this
process actually composed. A server nobody composed reports `not_managed`
rather than a readiness it never established.

### `services/runtime`

Owns model execution and tool invocation behind explicit contracts. Provider credentials and tool authority do not belong in the web client.

### `packages/contracts`

Canonical schemas for commands, events, plans, tools, memories, permissions, and provider requests.

### `packages/hermes-compat`

A narrow compatibility layer for importing supported Hermes configuration, skills, memory, and sessions. It must not leak Hermes-specific assumptions across the system.

## Storage direction

- SQLite is the default local store during early development.
- Storage access remains behind repository interfaces.
- A server-grade database may be supported later without weakening local-first operation.
- Sensitive local data must be encryptable with user-controlled keys.

## Communication

- Request/response APIs handle commands and queries.
- A typed event stream handles live progress.
- Every meaningful task transition is persisted before it is presented as complete.

## Task and process lifetime

The CLI is an observer of durable mission state, not the owner of the mission.
Attached mission and build commands therefore have an explicit lifetime
contract:

- `morrow mission` and `morrow build` observe by default. `--detach` is the
  explicit choice to leave a durable mission running after the CLI exits.
- An attached timeout, `SIGINT`, or `SIGTERM` calls the mission cancellation API.
  The API persists the cancellation, stops the controller, cancels the complete
  descendant task tree, and waits for active workers to settle before returning
  a terminal cancelled result. A CLI timeout never means "stop observing and
  leave the work running."
- Provider requests receive the task cancellation signal. Structured foreground
  commands have bounded timeouts and report whether they completed, timed out,
  were cancelled, or ended by signal, together with stdout, stderr, and exit
  status.
- Background commands are owned by the task that started them. They are
  reaped before a task runner settles unless a successfully completing task has
  explicitly requested `keepAlive`; cancellation and failure always reap them.
  Process-tree termination is used so descendants do not retain ports or file
  locks.

This boundary is implemented by `MissionControllerRunner`, `TaskRunner`, the
agent execution cleanup funnel, and `ProcessSupervisor`. Durable rows remain
the audit source of truth, while an in-memory supervisor only claims liveness
for processes owned by the current orchestrator instance.

## Trust boundaries

- The browser client is not trusted with provider secrets.
- Models are not trusted to grant themselves permissions.
- Tool results are treated as untrusted input.
- Extensions run with declared capabilities.
- External model providers receive only the context selected for that request.

## Context management

Agent model requests pass through the local context manager before provider
execution. The manager resolves model-aware budgets, counts tokens with exact
offline tokenizers where available and labeled conservative estimates elsewhere,
preserves system instructions and tool-call groups, compacts older eligible
history into redacted persisted summaries, and refuses provider calls when the
minimum viable prompt cannot fit. See [context-management.md](context-management.md).

Durable mission execution is segmented without replacing the task, mission,
event, provider, or Execution Kernel boundaries. Migration 32 adds execution
segments, discrete provider turns, structured checkpoints, private provider
continuations, and canonical task answers beside the existing authoritative raw
records. The mutable conversation assistant row remains a presentation buffer;
provider requests are rebuilt from discrete durable turns so prior narration is
never recursively concatenated. A checkpoint, compaction, route change, restart,
or turn-budget rollover cannot mark a task or mission complete.

Migration 32 is additive and lazily compatible: existing tasks need no backfill
and open their first segment on their next execution. Downgraded binaries ignore
the new tables. Operational rollback may drop those five tables only after
accepting the loss of resumability metadata; task, mission, conversation, event,
tool, and working-tree records are unaffected.

## Symbol index

Project code intelligence uses a local symbol index rather than sending whole
repositories to a model. The orchestrator scans only inside the registered
project root, applies `.gitignore`, `.morrowignore`, dependency/build/cache
ignores, and secret-like path denial, then persists symbol metadata and parser
diagnostics in SQLite. TS/JS/TSX/JSX symbols are extracted with the TypeScript
compiler API; JSON config keys are parsed as structured objects. Agent access is
read-only through concise symbol locations. See [symbol-index.md](symbol-index.md).

## Initial vertical slice

The first implementation should prove:

1. Project creation
2. Task submission
3. Visible plan generation
4. One scoped tool invocation
5. Streaming activity
6. Persisted checkpoints
7. Restart recovery
8. Privacy and execution evidence

No broad integration work should precede a reliable vertical slice.
