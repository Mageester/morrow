# Authoritative Runtime and Lifecycle Design

**Date:** 2026-08-28  
**Status:** Proposed first tranche of the Morrow trustworthy-agent turnaround  
**Turnaround goal:** `pasted-text-1.txt` SHA-256 `d8cb7cc43637bfb96eafad9971c02b63a84db94be757d1af1243fc5cc6cecf95`

## Purpose

Morrow currently has more than one production composition path. The direct
orchestrator entry creates the scheduler and durable work-graph integration,
while the CLI foreground service does not. Skill installation reports that a
new skill is disabled, but no authoritative activation state is persisted and
later discovery presents healthy directories as enabled. A legacy scheduled
task failure also writes task status through the low-level repository rather
than the canonical transition-and-event boundary.

These are not isolated presentation bugs. They allow the product's behavior to
depend on how it started and allow the UI, agent, and durable task history to
disagree. This tranche creates one composition authority, one skill catalog,
and one production task-transition path before workspace, Mission, terminal,
or web redesign proceeds.

## User outcome

Starting Morrow through the installed CLI, the source CLI, or the direct
orchestrator entry produces the same capabilities and recovery behavior. A
skill shown as disabled cannot execute; a skill shown as available can be
loaded by the agent; malformed and conflicting skills remain visible with an
actionable reason. Every production task status change has a corresponding
validated durable lifecycle event.

## Scope

This tranche includes:

1. A shared runtime composition root used by both production startup paths.
2. Symmetric startup, reconciliation, background-service, and shutdown
   ownership.
3. A canonical skill catalog shared by API projection and agent discovery.
4. Durable, restart-safe skill activation with fail-closed loading.
5. Removal of the remaining production task-status bypass in scheduled work.
6. Cross-entry and cross-surface integration tests.

This tranche does not rename database `project_id` fields, redesign Missions,
change the primary web navigation, or replace Git-derived workspace evidence.
Those changes require this runtime authority and are ordered next, not
discarded. It also does not add telemetry, hosted inference, or new external
dependencies.

## Evidence for the boundary

- `services/orchestrator/src/index.ts` constructs work-graph integration,
  includes it in startup reconciliation, and starts `SchedulerTicker`.
- `apps/cli/src/service/lifecycle.ts#serveForeground` independently constructs
  the runtime without work graphs or the scheduler.
- `services/orchestrator/src/index.ts` supplies the development bundled-skill
  fallback; the CLI composition path does not.
- `POST /api/skills/install` returns `enabled: false`, while
  `GET /api/skills` currently projects every discovered healthy directory as
  `enabled: true`.
- `services/orchestrator/src/execution/agent.ts` discovers and loads skills
  directly from roots instead of consuming the web/API catalog decision.
- `services/orchestrator/src/schedule/ticker.ts` calls
  `taskRepository.updateTaskStatus` on legacy dispatch failure instead of
  `taskRecordsRepository.transitionTask`.

## Considered approaches

### A. Shared composition and lifecycle authorities (selected)

Extract the already-proven components into focused services and make both
entrypoints consume them. Preserve durable mission, task, provider, and tool
boundaries while removing divergent wiring and status projections.

This is the smallest change that eliminates the defect classes rather than
patching each observed symptom.

### B. Patch each entrypoint and discovery loop separately

Adding the missing scheduler, work graph, skills environment, and activation
checks to each caller would be quick. It would retain multiple lists of what a
complete Morrow runtime contains and would drift again. Rejected.

### C. Rewrite task, project, Mission, skill, and startup schemas together

A single clean-slate model could remove more historical names immediately, but
it would combine data migration, runtime correctness, general-purpose workspace
support, and product IA into one unreviewable security-sensitive change.
Rejected for this tranche; later packages may delete superseded concepts once
their replacements are proven.

## Architecture

### 1. `MorrowRuntimeHost` is the composition authority

Create a focused orchestrator module whose public factory accepts explicit
paths, environment, network binding, adapters, logging hooks, and feature
switches. It owns construction of:

- the SQLite database;
- provider-secret hydration and legacy database migration;
- the shared `ProcessSupervisor`;
- `TaskRunner`;
- `MissionControllerRunner`;
- durable work-graph integration;
- startup reconciliation, including work graphs;
- the skill catalog;
- the Fastify application;
- `SchedulerTicker`;
- `EntitlementPoller`; and
- optional tokenizer warm-up.

The host exposes explicit `listen()` and idempotent `close()` operations.
`close()` stops the scheduler and entitlement poller, stops supervised process
groups, closes Fastify, and then closes SQLite. Signal handling and CLI output
remain entrypoint concerns; component ordering does not.

`services/orchestrator/src/index.ts` becomes a thin configuration and signal
adapter. `serveForeground` dynamically imports the same factory so lightweight
CLI commands keep their current startup performance.

Startup feature switches remain explicit and testable:

- `scheduler: false` only when `MORROW_DISABLE_SCHEDULER=true`;
- `tokenizerWarmup: false` when disabled or no eligible provider exists;
- entitlement polling remains locally inert without a user-created pairing;
- no production entrypoint may silently omit work graphs or reconciliation.

### 2. Startup reconciliation is one ordered operation

The host performs startup in this order:

1. Resolve paths and bundled-skill roots.
2. Hydrate provider secrets and migrate the legacy database.
3. Open SQLite and construct durable repositories/services.
4. Build runner, controller, work graphs, skill catalog, and HTTP application.
5. Reconcile missions, tasks, and unfinished work graphs.
6. Listen on the requested address.
7. Start scheduler, entitlement polling, background model catalog, and eligible
   tokenizer warm-up.

If a required step before listening fails, the host closes constructed
resources and startup fails with a classified error. Optional background work
may report degraded status but cannot silently alter task or skill truth.

### 3. `SkillCatalog` is the discovery and activation authority

Create one catalog service in `services/orchestrator/src/skills/`. It owns the
configured bundled and user-install roots and produces a project-scoped view
when given that project's workspace root. Both `GET /api/skills` and the
agent's `find_skill`/`load_skill` tools query this service. No caller
independently walks skill directories or decides whether a skill is executable.

The catalog returns a strict entry:

```ts
interface SkillCatalogEntry {
  key: string;
  id: string;
  name: string;
  description: string;
  source: "bundled" | "user" | "workspace";
  directory: string;
  enabled: boolean;
  validation: "healthy" | "invalid" | "conflict" | "missing";
  issues: string[];
  loadable: boolean;
  manifestDigest: string | null;
}
```

`loadable` is derived only as `enabled && validation === "healthy"`. The API
may omit the private absolute `directory`, but it must preserve the same state,
issues, and decision.

`key` is the opaque, source-qualified identity used by mutation APIs. `id` is
the manifest-declared name used for agent lookup. Identity collisions fail
closed within one project-scoped view. If two active roots declare the same
skill ID, every conflicting entry is non-loadable and the catalog reports all
source kinds involved. Directory iteration order never chooses a winner.

### 4. Skill activation is durable and restart-safe

Add a SQLite activation table keyed by the source-qualified catalog identity:

```sql
CREATE TABLE skill_activations (
  skill_key TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bundled', 'user', 'workspace')),
  project_id TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK ((source = 'workspace' AND project_id IS NOT NULL)
      OR (source <> 'workspace' AND project_id IS NULL))
);
```

Keys are `bundled:<id>`, `user:<id>`, and
`workspace:<projectId>:<id>`. This keeps workspace activation private to its
project and avoids ambiguous `NULL` behavior in a composite primary key.

Defaults are explicit:

- bundled skills default enabled unless a persisted override disables them;
- newly installed user skills receive `enabled = 0` in the same successful
  install operation;
- workspace skills default disabled until explicitly enabled;
- invalid, missing, or conflicting skills are never loadable regardless of a
  stale activation row.

Add `PATCH /api/skills/:skillKey` with strict `{ enabled: boolean }`. Enabling
requires one currently healthy, unambiguous catalog entry. Disabling remains
available even if the files later become invalid or missing. Removing a user
skill removes its activation row after filesystem removal succeeds. Bundled
skills remain non-removable but disableable.

Installation is not considered complete until the promoted directory and the
disabled activation row both exist. Because SQLite and filesystem rename cannot
share a transaction, failure recovery is explicit: if activation persistence
fails, move the promoted directory back to staging or remove it and return a
failed install; never leave an enabled-or-ambiguous half-install.

### 5. Skill refresh and errors are truthful

The catalog refreshes deterministically at startup and after install, remove,
enable, or disable operations. Agent lookup also performs a bounded freshness
check so external filesystem changes do not require a service restart.

Malformed manifests, unreadable roots, duplicate IDs, checksum failures, and
missing `SKILL.md` files produce catalog entries or root diagnostics rather
than disappearing. UI copy distinguishes:

- available and enabled;
- installed but disabled;
- present but invalid;
- conflicting;
- source root unavailable; and
- no skills installed.

The agent receives the same actionable issue when `load_skill` is refused.

### 6. Production task transitions use one facade

`taskRepository` remains a low-level persistence primitive for migrations and
isolated fixtures, but production status changes use
`taskRecordsRepository.transitionTask`. The legacy scheduled-task dispatch
failure records a classified `task.failed` event with the schedule ID and safe
error summary. If task creation never committed, only the schedule failure is
recorded; the code must not fabricate a task transition.

Repository searches and a static regression guard cover production source so a
new raw `updateTaskStatus` caller cannot reintroduce the bypass. Samples and
tests may use low-level setup helpers only when they are clearly fixture code.

### 7. Health exposes composition, not optimistic readiness

The health boundary reports a versioned runtime-capability object derived from
constructed components, including scheduler enabled/disabled, work-graph
integration ready, startup reconciliation completed, and skill-catalog status.
It does not report a component as ready merely because the process is listening.
The web and CLI can therefore explain degraded state without guessing.

## Data flow

```text
entrypoint configuration
        |
        v
MorrowRuntimeHost -----> startup reconciliation -----> durable task/mission state
        |                         |
        |                         +---- work-graph recovery
        |
        +---- SkillCatalog <---- skill roots + skill_activations
        |          |                         |
        |          +---- API projection     +---- enable/disable/install/remove
        |          +---- agent find/load
        |
        +---- Fastify / TaskRunner / Scheduler / Controller / Supervisor
```

## Failure behavior

- Required composition failure aborts startup and closes resources in reverse
  ownership order.
- Scheduler failure is recorded against the schedule/run and, when a task
  exists, through the canonical task transition with a durable event.
- Skill root I/O or validation failure degrades that root/catalog entry and is
  visible; it does not make healthy skills from other roots disappear.
- A disabled or ambiguous skill cannot be loaded by ID or path.
- Repeated startup and shutdown are idempotent and do not duplicate scheduler
  intervals, entitlement pollers, work-graph imports, or task dispatch.

## Security and privacy

This is security-sensitive because it changes skill loading and unattended
execution composition. Implementation requires an independent Luna Max review.

- Activation fails closed.
- Catalog identity comes from verified manifests, not request paths.
- Absolute directories remain server-side.
- Existing workspace containment, tool approvals, permission profiles,
  credential storage, and local-first defaults remain unchanged.
- The change adds no telemetry or external calls. Entitlement polling retains
  its current explicit-pairing gate.
- Health data exposes capability state, not credentials, paths, prompts, or
  private task contents.

## Compatibility and migration

- Existing databases migrate with bundled skills effectively enabled and
  user/workspace skills disabled until explicitly enabled. This is a deliberate
  fail-closed correction; the UI and CLI must explain it.
- Existing installed directories are retained. They become catalog entries and
  are not deleted during migration.
- Existing API consumers continue receiving the current skill fields plus the
  opaque key and truthful validation/issues fields. The install response
  remains disabled and adds the new key.
- Existing `MORROW_DISABLE_SCHEDULER`, `MORROW_SKILLS_DIR`, provider, database,
  bind-host, port, and web-root configuration remains supported.
- CLI light commands retain dynamic imports and must not regress the established
  startup benchmark materially.

## Verification

Implementation follows red-green TDD and proves:

1. Direct and CLI composition both construct work graphs, perform the same
   reconciliation, discover the same skills, and start/disable the scheduler
   under the same configuration.
2. `close()` stops every owned background component once and closes the
   database after dependants.
3. A user skill is disabled immediately after install, cannot load, can be
   enabled explicitly, loads through both API and agent lookup, and retains its
   state after SQLite close/reopen.
4. Bundled disablement survives restart; workspace skills default disabled.
5. Invalid, unreadable, missing, and duplicate skills are visible and
   non-loadable with stable diagnostics.
6. API and agent catalog decisions are byte-for-byte equivalent for state,
   validation, and issue codes.
7. Scheduled dispatch failure persists a legal task transition/event without a
   raw production status write or fabricated task.
8. Startup recovery is idempotent across repeated construction and process
   restart fixtures.
9. Focused orchestrator and CLI tests pass, followed by both package suites,
   contracts tests, type checks, and the strongest relevant repository gate.
10. Startup benchmark comparison shows no material regression for `morrow
    --version` and reports the service-start delta honestly.

## Acceptance criteria

The tranche is accepted only when:

- there is one production runtime component list;
- both startup paths consume it;
- scheduler, work graphs, reconciliation, skills, and shutdown behavior match;
- every catalog-visible enabled skill is agent-loadable and every disabled or
  unhealthy skill is refused;
- skill activation survives restart and UI/runtime state agrees;
- no production task status change bypasses validated transition events;
- errors remain actionable and completed work is preserved;
- focused and regression verification passes after the last change;
- independent security review has no unresolved Critical or High finding; and
- architecture, user-visible behavior, migration, rollback, privacy, and known
  limitations are documented from verified facts.

## Rollback

The runtime host can be reverted by restoring the two entrypoint composition
blocks. The skill migration is additive; rollback leaves the activation table
unused without deleting installed skills. If the catalog must be rolled back,
user-installed skills remain on disk and no activation data is destroyed. The
scheduled transition correction is independently revertible, though doing so
would restore a known truthfulness defect.

## Ordered follow-on packages

1. Workspace-neutral execution and non-Git evidence, including a real
   `~/Downloads`-style product gate without automatic `git init`.
2. Canonical tool-call lifecycle and provider-independent continuation/recovery.
3. Goal/task/run/Mission product-model simplification.
4. Terminal and web information architecture over authoritative state.
5. Context/token efficiency, compatibility expansion, product gauntlets, clean
   installation, adversarial completion review, and verified beta release.
