# ADR 0018: Authoritative Runtime and Skill Lifecycle

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

Morrow has two ways to start: the standalone `services/orchestrator` entrypoint,
and the CLI's in-process `serveForeground` behind `morrow start`. The second is
what a packaged install runs. They each assembled their own component list, and
they had drifted:

- `morrow start` constructed no `SchedulerTicker`, so a scheduled routine
  silently never fired under a packaged install.
- It constructed no work-graph integration and passed none to startup
  reconciliation, so durable child fan-out was never replayed after a restart.
- Neither path constructed a `SkillCatalog`, so the server built its own and the
  `TaskRunner` had none. The activation authority added in the catalog work
  reached the API but not the agent.

Nothing a user can see distinguishes the two entrypoints, so no one could reason
about why a feature worked in one and not the other.

Skill state had the same shape of problem one level up. The CLI kept activation
in its own config (`skills.<id>.enabled`), the web page rendered a locally
declared schema with no activation state at all, and the agent walked skill
roots itself. Three surfaces, three answers, and a person could be told a skill
was enabled that the agent would refuse to load.

Health made a related claim: it reported `ok: true` and nothing else, so a
server that had reconciled nothing was indistinguishable from a fully composed
runtime.

## Decision

1. **One composition root.** `createMorrowRuntimeHost` owns secret hydration,
   legacy migration, database, process supervisor, skill catalog, task runner,
   mission controller, work graphs, startup reconciliation, HTTP server,
   scheduler, entitlement poller, and tokenizer warm-up. Both entrypoints call
   it. Neither may construct a component itself.

2. **Background work starts after listen.** The scheduler and tokenizer warm-up
   start only once the server is serving, so a failed bind cannot leave a timer
   in a process that is about to die. `close()` is idempotent and unwinds in a
   fixed order: scheduler, entitlement poller, supervisor drain, server,
   database — the same order for a fully started runtime and a partially
   constructed one.

3. **The catalog is the only skill authority.** `SkillCatalog` decides what
   exists, what is valid, what is enabled, and what is loadable
   (`enabled && validation === "healthy"`). The server, the runner, and through
   it the agent all receive the same instance. The CLI and web read and write
   that state over the API and hold no activation opinion of their own. Skill
   directories stay server-side; no client is told where a skill lives.

4. **A never-used root is not a fault.** A missing bundled root means shipped
   skills are gone and is reported. A missing user or workspace root is the
   normal state of a fresh install and is not, so a new user's catalog does not
   read as broken.

5. **Health reports composition, not intent.** `GET /api/health` carries a
   required `runtime` object: `startupReconciled`, `workGraphs`, `scheduler`,
   and skill catalog counts. A server nobody composed — one built directly by a
   test or an embedding host — reports `startupReconciled: false` and
   `not_managed`, which is different from both "ready" and "broken". The route
   never fabricates readiness it cannot observe.

6. **One writer for task status.** Production task transitions go through
   `taskRecordsRepository.transitionTask`, which validates the transition and
   appends the matching event. A repository check fails the build on any other
   production caller of `updateTaskStatus`.

## Consequences

- A scheduled routine now fires under `morrow start`, and work graphs are
  reconciled on every startup path. This is new behaviour for packaged installs,
  and it is the behaviour the standalone entrypoint always had.
- `HealthSchema.runtime` is required. An older client that parses health
  strictly and predates this field will reject the response; clients ship with
  the service, so this affects only out-of-tree consumers.
- The CLI config key `skills.<id>.enabled` no longer has any effect. Onboarding
  clears leftovers; the value is otherwise inert.
- `morrow skills list|inspect|verify|enable|disable|remove` now require a
  running service, because the answer they report belongs to the service. The
  authoring helpers (`create`, `update`, `backup`, `rollback`, `archive`) remain
  filesystem-local.
- A scheduled dispatch failure now leaves a durable `task.failed` event with a
  bounded, single-line reason instead of an unexplained status.

## Rollback

Reverting the host restores two divergent entrypoints and reintroduces the
missing scheduler and work graphs under `morrow start`. Reverting the catalog
wiring returns three independent skill answers. Migration 73
(`skill_activations`) is additive; leaving the table in place is harmless.

## Verification

- `pnpm check` (typecheck + repository validation, including the new task-status
  authority guard) — pass.
- `pnpm test` — pass: orchestrator 2808, CLI 862, web 453, contracts 88,
  dashboard 7, hosted-api 15, ui 14, hermes-compat 4, hosted-contracts 10.
- `node --test scripts/task-status-authority.test.mjs` — pass.
- `pnpm build` — pass.
- Live service on an isolated `MORROW_HOME`: health reports
  `startupReconciled: true`, `workGraphs: "ready"`, `scheduler: "running"` under
  `morrow start`; disabling a skill from the CLI hides it from `find_skill`,
  makes `load_skill` refuse it with `SKILL_NOT_LOADABLE`, survives a restart,
  and is reflected identically in the API, the CLI, and the web Skills page;
  enabling it from the web page changes the runtime's answer.
- A task killed mid-run returns as `interrupted` with `task.recovery_required`,
  and resumes to completion.
