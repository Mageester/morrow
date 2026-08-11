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

## Agentic harness evolution boundaries

The Tasks 1-8 harness changes are additive around the existing orchestrator
boundaries. The orchestrator owns the durable records and policy decisions;
`packages/contracts` defines the browser-safe shapes; `apps/web` renders those
shapes and never receives provider credentials.

### Durable records and authority

- `task_cost_lines` is the cost ledger. Each request is idempotent by
  task/request identity and retains its fixed-point amount, usage values,
  accuracy, and pricing snapshot. Historical lines do not change when current
  catalog prices change.
- Research source records retain a normalized URL, content hash, retrieval
  time, publication metadata when available, citations, and task provenance.
  The source snapshot is server-side and fetched instructions are untrusted.
- Memory candidates are separate from active memory. The candidate lifecycle
  is the approval boundary; retrieval and forget operate on the resulting
  scope, not on model suggestions.
- Skill drafts retain provenance, declared tools/scopes/domains/secrets,
  safety results, replay fixtures, and rollback state. A draft is not active
  merely because a model proposed it.
- Improvement proposals retain evidence task IDs, benchmark fixture IDs,
  expected effect, privacy impact, shadow evaluation, rollout version, and
  rollback reference. Shadow evidence is required before promotion.

### Task-sync recovery contract

The durable task aggregate is the source of truth for answer, status, events,
cost, and verification. SSE is an ordered delivery channel with cursor replay,
not a second state store. After a silent stream, reconnect, refresh, or browser
visibility change, the client may reconcile from the authoritative aggregate
and must not require a navigation to display a completed answer.

### Feature boundaries and rollback

The first release keeps research, memory admission, skill activation, and
optimization promotion behind their existing policy/review boundaries:

1. Local-only research remains blocked; controlled-cloud research requires an
   approved network-capable path and records provenance.
2. Memory candidates remain proposed until the user chooses scope and
   retention. Forget is immediately effective for retrieval.
3. Skills remain quarantined or in review until safety and replay gates pass;
   there is no automatic activation.
4. Optimization remains shadow-only until a user approves the versioned
   proposal; rollback returns to the prior approved version.

All new persistence is additive and must be migrated through the normal local
database migration path. Operational rollback is feature-first: stop creating
or promoting the new records, keep the records readable for diagnosis, and
serve the previous UI/provider projection. Do not drop new tables while active
tasks depend on their replay or provenance metadata; only remove them after a
separate data-retention decision confirms that no resumability or audit record
is needed. Existing task, mission, event, tool, and workspace records remain
the rollback anchor.

The release gate proves deterministic local contracts and the local Playwright
surface. It does not prove live external-provider output quality, a provider's
invoice total, or arbitrary live-browser behavior; those are separate gates.
