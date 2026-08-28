# Authoritative Runtime and Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every production Morrow startup expose the same runtime and make skill and task lifecycle state authoritative across the agent, CLI, web, and persistence.

**Architecture:** A durable `SkillCatalog` becomes the only skill activation and loadability authority. A shared `MorrowRuntimeHost` composes the database, runner, controller, work graphs, catalog, HTTP server, scheduler, reconciliation, poller, and shutdown once for both startup entrypoints; production task transitions remain evented through `taskRecordsRepository`.

**Tech Stack:** TypeScript 5.9, Node.js 24, SQLite/better-sqlite3, Fastify, React 19, TanStack Query, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-28-authoritative-runtime-lifecycle-design.md`

## Global Constraints

- Activation fails closed: only `enabled && validation === "healthy"` is loadable.
- Catalog identity comes from verified manifests; absolute directories remain server-side.
- Bundled skills default enabled, user-installed and workspace skills default disabled, and every override survives restart.
- Both production startup paths must consume one runtime component list and identical reconciliation order.
- Production task status changes use validated transition events; no new raw status mutation is allowed.
- Preserve local-first behavior, provider choice, containment, approvals, credentials, privacy, work-graph fencing, and existing durable completion rules.
- Add no telemetry, hosted inference, or external dependency.
- Production behavior changes require RED/GREEN evidence and independent Luna Max security review.
- Do not modify protected prototype/UI files listed in `agent_docs/project_structure.md`.
- Luna workers do not edit Git state or main-owned status documents; the Sol controller creates focused commits after each reviewed package.

---

### Task 1: Durable skill catalog and activation authority

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `services/orchestrator/src/database.ts`
- Modify: `services/orchestrator/test/database.test.ts`
- Create: `services/orchestrator/src/repositories/skill-activations.ts`
- Create: `services/orchestrator/src/skills/catalog.ts`
- Create: `services/orchestrator/test/skill-catalog.test.ts`
- Modify: `services/orchestrator/src/lib.ts`

**Interfaces:**
- Produces: `SkillCatalogEntrySchema`, `SkillCatalogIssueSchema`, `SetSkillActivationSchema`, and their inferred types.
- Produces: migration 73 `skill_activations` with source-qualified `skill_key`.
- Produces: `skillActivationsRepository(db)` and `createSkillCatalog(deps)`.
- Consumes: `verifySkillDirectory`, install-root resolution, project/workspace identity.

- [ ] **Step 1: Add failing contract tests for strict catalog state**

Add assertions in `packages/contracts/test/contracts.test.ts` equivalent to:

```ts
expect(SkillCatalogEntrySchema.parse({
  key: "user:calendar",
  id: "calendar",
  name: "Calendar",
  description: "Manage calendar work.",
  source: "user",
  enabled: false,
  validation: "healthy",
  issues: [],
  loadable: false,
  manifestDigest: "a".repeat(64),
  category: "productivity",
  trustTier: "controlled",
  tools: [],
  permissions: [],
  dependencies: [],
  publisher: "local",
})).toMatchObject({ key: "user:calendar", loadable: false });
expect(() => SetSkillActivationSchema.parse({ enabled: true, extra: true })).toThrow();
```

- [ ] **Step 2: Run the contract test and capture RED**

Run: `pnpm --filter @morrow/contracts test -- contracts.test.ts`  
Expected: FAIL because the catalog and activation schemas do not exist.

- [ ] **Step 3: Add strict shared schemas**

Add the following public shape to `packages/contracts/src/index.ts`, retaining the current installed-skill presentation fields so web and CLI consumers do not invent another schema:

```ts
export const SkillCatalogIssueSchema = z.object({
  code: z.enum(["root_unavailable", "missing_skill_md", "invalid_manifest", "checksum_mismatch", "id_conflict", "unreadable"]),
  message: z.string().min(1).max(1000),
}).strict();
export const SkillCatalogEntrySchema = z.object({
  key: z.string().min(1).max(512),
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  description: z.string().max(2000),
  source: z.enum(["bundled", "user", "workspace"]),
  enabled: z.boolean(),
  validation: z.enum(["healthy", "invalid", "conflict", "missing"]),
  issues: z.array(SkillCatalogIssueSchema),
  loadable: z.boolean(),
  manifestDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  category: z.string(),
  trustTier: z.string(),
  tools: z.array(z.string()),
  permissions: z.array(z.string()),
  dependencies: z.array(z.string()),
  publisher: z.string(),
}).strict().superRefine((value, ctx) => {
  if (value.loadable !== (value.enabled && value.validation === "healthy")) {
    ctx.addIssue({ code: "custom", message: "loadable must equal enabled && healthy" });
  }
});
export const SetSkillActivationSchema = z.object({ enabled: z.boolean() }).strict();
export const SkillCatalogStatusSchema = z.object({
  healthy: z.boolean(),
  entries: z.number().int().nonnegative(),
  loadable: z.number().int().nonnegative(),
  issues: z.array(SkillCatalogIssueSchema),
}).strict();
```

- [ ] **Step 4: Add migration and repository RED tests**

In `services/orchestrator/test/database.test.ts`, open a fresh database and assert migration 73 plus the columns and check constraint. In `services/orchestrator/test/skill-catalog.test.ts`, first write tests that call the not-yet-created repository and verify:

```ts
activations.set({ skillKey: "workspace:p1:lint", skillId: "lint", source: "workspace", projectId: "p1", enabled: true, updatedAt: NOW });
expect(activations.get("workspace:p1:lint")?.enabled).toBe(true);
expect(() => activations.set({ skillKey: "workspace:p1:lint", skillId: "lint", source: "workspace", projectId: null, enabled: true, updatedAt: NOW })).toThrow();
```

Run: `pnpm --filter @morrow/orchestrator test -- database.test.ts skill-catalog.test.ts`  
Expected: FAIL because migration 73, repository, and catalog do not exist.

- [ ] **Step 5: Implement migration 73 and the activation repository**

Append migration 73 exactly as specified in the design, including the source/project check. Implement:

```ts
export interface SkillActivationRecord {
  skillKey: string; skillId: string; source: "bundled" | "user" | "workspace";
  projectId: string | null; enabled: boolean; updatedAt: string;
}
export function skillActivationsRepository(db: Database.Database) {
  return {
    get(skillKey: string): SkillActivationRecord | undefined,
    list(): SkillActivationRecord[],
    set(input: SkillActivationRecord): SkillActivationRecord,
    remove(skillKey: string): boolean,
  };
}
```

Map SQLite integers to booleans explicitly and parse source values before returning them.

- [ ] **Step 6: Implement the deterministic catalog**

Implement these public interfaces in `services/orchestrator/src/skills/catalog.ts`:

```ts
export interface SkillCatalogScope { projectId?: string; workspacePath?: string; }
export interface SkillCatalog {
  list(scope?: SkillCatalogScope): SkillCatalogEntry[];
  resolveById(id: string, scope?: SkillCatalogScope): SkillCatalogEntry;
  getByKey(key: string, scope?: SkillCatalogScope): SkillCatalogEntry | undefined;
  setEnabled(key: string, enabled: boolean, scope?: SkillCatalogScope): SkillCatalogEntry;
  loadInstructions(key: string, scope?: SkillCatalogScope): { entry: SkillCatalogEntry; instructions: string };
  removeActivation(key: string): boolean;
  status(scope?: SkillCatalogScope): SkillCatalogStatus;
}
export function createSkillCatalog(deps: {
  db: Database.Database;
  bundledRoot?: string | null;
  userRoot?: string | null;
  now?: () => string;
}): SkillCatalog;
```

Use source-qualified keys, sort by `(id, source, key)`, default bundled to enabled and user/workspace to disabled, include invalid entries with stable issue codes, and mark all duplicate declared IDs in the current scope as `conflict`. Never expose absolute directories in `SkillCatalogEntry`; keep them in a private internal record used only by `loadInstructions`. Catalog status returns sanitized root issues without absolute paths so an unavailable empty root is distinguishable from an empty healthy catalog.

- [ ] **Step 7: Cover restart, conflict, malformed, and root failures**

Add fixtures proving persisted bundled disablement and user enablement survive close/reopen; workspace activation is project-scoped; duplicate IDs fail closed independent of directory order; checksum mismatch and missing `SKILL.md` remain listed; an unreadable root does not hide healthy entries in another root.

Run: `pnpm --filter @morrow/contracts test -- contracts.test.ts && pnpm --filter @morrow/orchestrator test -- database.test.ts skill-catalog.test.ts`  
Expected: PASS.

- [ ] **Step 8: Export and commit the foundation**

Export the catalog and repository from `services/orchestrator/src/lib.ts` and run:

`pnpm --filter @morrow/contracts check && pnpm --filter @morrow/orchestrator check`

Commit: `feat(orchestrator): add authoritative skill catalog`

---

### Task 2: Wire the catalog through API and agent execution

**Files:**
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/src/runner.ts`
- Modify: `services/orchestrator/src/execution/agent.ts`
- Modify: `services/orchestrator/src/skills/install.ts`
- Modify: `services/orchestrator/test/api.test.ts`
- Modify: `services/orchestrator/test/skill-install-api.test.ts`
- Modify: `services/orchestrator/test/agent-install-skill.test.ts`
- Modify: `services/orchestrator/test/agent-loop.test.ts`
- Modify: `services/orchestrator/test/bundled-skills-trust.test.ts`

**Interfaces:**
- Consumes: Task 1 `SkillCatalog` and shared schemas.
- Produces: `ServerDependencies.skillCatalog`, `TaskRunner` catalog injection, and `executeAgentChatTask(..., skillCatalog)`.
- Produces: `PATCH /api/skills/:skillKey`; project-aware `GET /api/skills?projectId=...`; `GET /api/skills/status`; source-qualified removal.

- [ ] **Step 1: Add API RED tests for truthful state and activation**

Extend `api.test.ts` and `skill-install-api.test.ts` to assert:

```ts
const installed = await app.inject({ method: "POST", url: "/api/skills/install", payload: { handle } });
expect(installed.json()).toMatchObject({ key: "user:demo", id: "demo", enabled: false });
expect((await app.inject({ method: "GET", url: "/api/skills" })).json())
  .toEqual(expect.arrayContaining([expect.objectContaining({ key: "user:demo", enabled: false, loadable: false })]));
expect((await app.inject({ method: "PATCH", url: "/api/skills/user%3Ademo", payload: { enabled: true } })).json())
  .toMatchObject({ enabled: true, loadable: true });
```

Also assert invalid enable returns `409 SKILL_NOT_LOADABLE`, an unknown key returns 404, and no response includes `directory`.

- [ ] **Step 2: Add agent RED tests for shared decisions**

Add deterministic provider/tool tests proving `find_skill` lists only loadable entries, `load_skill` refuses disabled/conflicting entries with the catalog issue, and a newly enabled entry loads the same `SKILL.md` bytes represented by the API entry's digest.

Run: `pnpm --filter @morrow/orchestrator test -- api.test.ts skill-install-api.test.ts agent-install-skill.test.ts agent-loop.test.ts bundled-skills-trust.test.ts`  
Expected: FAIL because API and agent still scan directories independently.

- [ ] **Step 3: Inject the catalog into server, runner, and agent**

Extend dependencies without breaking direct test construction:

```ts
// server.ts
skillCatalog?: SkillCatalog;

// runner.ts
constructor(db: Database.Database, executor?: TaskExecutor, supervisor?: ProcessSupervisor, skillCatalog?: SkillCatalog)

// execution/agent.ts Dependencies
skillCatalog?: SkillCatalog;
```

Production runtime construction must pass one instance to both `TaskRunner` and `buildServer`. Tests that call these boundaries directly may create a catalog from the same database, but no production caller may walk roots itself.

- [ ] **Step 4: Replace server scanning with catalog projection**

Delete the inline `GET /api/skills` directory scanner. Parse optional `projectId`, resolve its workspace through `projectRepository`, and return the catalog view. Add `GET /api/skills/status` over the same project scope so root diagnostics remain visible even when there are no entries. Add strict activation handling:

```ts
app.patch("/api/skills/:skillKey", async (request) => {
  const { skillKey } = request.params as { skillKey: string };
  const body = SetSkillActivationSchema.parse(request.body);
  return skillCatalog.setEnabled(skillKey, body.enabled, projectScope(request));
});
```

Map catalog not-found, conflict, invalid, and disabled errors to stable API codes.

- [ ] **Step 5: Make install/remove activation-safe**

Refactor the install promotion boundary so a user installation is not successful until `user:<id>` is persisted disabled. Retain the displaced prior directory until activation persistence succeeds; on failure restore it and return `SKILL_INSTALL_FAILED`. Remove by catalog key, reject bundled/workspace removal, and delete activation only after user-directory removal succeeds.

- [ ] **Step 6: Replace agent root walking**

Remove `agentSkillRoots`, `discoverAgentSkills`, and direct `SKILL.md` selection from agent tool handling. Resolve the current task project scope once and use:

```ts
const entry = catalog.resolveById(skillId, { projectId, workspacePath });
const instructions = catalog.loadInstructions(entry.key, { projectId, workspacePath });
```

Preserve agent-specific `AgentSkillAccess` as an additional deny/allow boundary; it cannot enable a globally disabled or invalid catalog entry. Record usage only after successful instruction load.

- [ ] **Step 7: Run focused GREEN and adjacent regressions**

Run:

`pnpm --filter @morrow/orchestrator test -- skill-catalog.test.ts api.test.ts skill-install.test.ts skill-install-api.test.ts agent-install-skill.test.ts agent-loop.test.ts bundled-skills-trust.test.ts skill-usage.test.ts`

Expected: PASS with API and agent state agreement.

- [ ] **Step 8: Typecheck and commit integration**

Run: `pnpm --filter @morrow/orchestrator check && pnpm --filter @morrow/contracts check`  
Commit: `fix(orchestrator): enforce skill activation at runtime`

---

### Task 3: Replace CLI and web skill approximations with catalog state

**Files:**
- Modify: `apps/cli/src/client/api.ts`
- Modify: `apps/cli/src/commands/skills.ts`
- Modify: `apps/cli/src/commands/chat.ts`
- Modify: `apps/cli/src/commands/onboard.ts`
- Modify: `apps/cli/src/commands/capabilities.ts`
- Modify: `apps/cli/src/skills/registry.ts`
- Modify: `apps/cli/test/skills.test.ts`
- Modify: `apps/cli/test/skills-install-command.test.ts`
- Modify: `apps/cli/test/bundled-skills.test.ts`
- Modify: `apps/cli/test/capabilities.test.ts`
- Modify: `apps/web/src/api/skills.ts`
- Modify: `apps/web/src/features/skills/skills-page.tsx`
- Modify: `apps/web/src/features/skills/skills-page.test.tsx`
- Modify: `apps/web/src/features/skills/install-skill-panel.tsx`
- Modify: `apps/web/src/features/skills/install-skill-panel.test.tsx`

**Interfaces:**
- Consumes: Task 2 catalog API and shared `SkillCatalogEntrySchema`.
- Produces: API-backed CLI list/search/inspect/enable/disable and slash-command inventory.
- Produces: web activation controls and truthful disabled/invalid/conflict/root-unavailable states.

- [ ] **Step 1: Add CLI RED tests for server-authoritative state**

Update CLI tests so a local config value cannot make a server-disabled skill appear enabled. Mock the API with two entries and assert `skills list`, `skills enable`, `skills disable`, the capability count, and the interactive chat skill list use the returned `key`, `enabled`, `validation`, and `loadable` values. Assert enable calls `PATCH /api/skills/<encoded key>` and does not write `skills.<id>.enabled` to CLI config.

- [ ] **Step 2: Add web RED tests for all visible states**

Extend the Skills page fixture with healthy-enabled, healthy-disabled, invalid, and conflict entries. Assert exact labels `Enabled`, `Disabled`, `Needs attention`, and `Conflict`; assert the enable button is absent for unhealthy entries; assert successful activation invalidates `['skills','installed']`; assert root failure displays its issue instead of `No skills yet`.

Run: `pnpm --filter @morrow/cli test -- skills.test.ts skills-install-command.test.ts bundled-skills.test.ts && pnpm --filter @morrow/web test -- skills-page.test.tsx install-skill-panel.test.tsx`  
Expected: FAIL because both clients still use local/optimistic schemas.

- [ ] **Step 3: Add typed API client methods**

Use the shared catalog type in CLI and web. Add:

```ts
listSkills(projectId?: string): Promise<SkillCatalogEntry[]>;
getSkillStatus(projectId?: string): Promise<SkillCatalogStatus>;
setSkillEnabled(key: string, enabled: boolean, projectId?: string): Promise<SkillCatalogEntry>;
removeSkill(key: string): Promise<void>;
```

Update install result schemas to require `{ key, id, enabled: false }`. Include `projectId` only for project-scoped workspace views.

- [ ] **Step 4: Route CLI state-changing and runtime-facing reads through the API**

Change `skills list/search/inspect/verify/enable/disable/remove`, capability counts, and chat slash-command population to use the running service. `skills create/update/backup/rollback/archive` may retain their filesystem authoring helpers, but after a filesystem mutation they must refresh and display catalog state rather than alter activation config. Onboarding recommendations call `setSkillEnabled`; they never write the legacy config key. Narrow `apps/cli/src/skills/registry.ts` to authoring-time verification used by creator/curator operations; remove runtime-facing discovery exports once all consumers move to the catalog API.

- [ ] **Step 5: Render truthful web state and controls**

Replace the local `InstalledSkillSchema` with the shared schema and query catalog status alongside the entry list. In `SkillDossier`, show issue messages for unhealthy entries and use a mutation-backed enable/disable button only when valid. If the list is empty but status has root issues, render those issues instead of `No skills yet`. Keep install copy explicit that the result is disabled; offer an `Enable now` action using the returned key without enabling automatically.

- [ ] **Step 6: Run client GREEN and typechecks**

Run:

`pnpm --filter @morrow/cli test -- skills.test.ts skills-install-command.test.ts bundled-skills.test.ts capabilities.test.ts && pnpm --filter @morrow/web test -- skills-page.test.tsx install-skill-panel.test.tsx && pnpm --filter @morrow/cli check && pnpm --filter @morrow/web check`

Expected: PASS.

- [ ] **Step 7: Commit the client truthfulness change**

Commit: `fix(skills): align clients with runtime catalog`

---

### Task 4: Shared runtime host and truthful health composition

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Create: `services/orchestrator/src/runtime/host.ts`
- Modify: `services/orchestrator/src/lib.ts`
- Modify: `services/orchestrator/src/index.ts`
- Modify: `services/orchestrator/src/server.ts`
- Create: `services/orchestrator/test/runtime-host.test.ts`
- Modify: `services/orchestrator/test/api.test.ts`
- Modify: `apps/cli/src/service/lifecycle.ts`
- Modify: `apps/cli/test/service-lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2 `SkillCatalog`; existing runner/controller/work-graph/scheduler/poller/supervisor boundaries.
- Produces: shared `RuntimeCapabilityStatusSchema`; `createMorrowRuntimeHost(config, overrides?)`, `MorrowRuntimeHost.listen()`, `close()`, `status()`.
- Produces: versioned health `runtime` capability object.

- [ ] **Step 1: Add host RED tests for component parity and shutdown ordering**

Create `runtime-host.test.ts` with injected factories/spies. Assert the host constructs one shared supervisor, catalog, runner, controller, and work graph; passes work graphs to reconciliation; starts scheduler only after listen; and closes in this order:

```ts
expect(events).toEqual([
  "scheduler.stop", "entitlement.stop", "supervisor.stopAllAndWait",
  "app.close", "db.close",
]);
```

Call `close()` twice and assert each event occurs once. Add a failed-listen case proving all constructed resources close and no background timer starts.

- [ ] **Step 2: Add cross-entry RED tests**

In `packages/contracts/test/contracts.test.ts`, assert `HealthSchema` requires a strict runtime object. In `apps/cli/test/service-lifecycle.test.ts`, mock the orchestrator package and assert `serveForeground` delegates to `createMorrowRuntimeHost` rather than reconstructing components. In `api.test.ts`, assert health contains:

```ts
runtime: {
  version: 1,
  startupReconciled: true,
  workGraphs: "ready",
  scheduler: "running" | "disabled",
  skills: { healthy: true, entries: expect.any(Number), loadable: expect.any(Number), issues: expect.any(Number) },
}
```

Run: `pnpm --filter @morrow/orchestrator test -- runtime-host.test.ts api.test.ts && pnpm --filter @morrow/cli test -- service-lifecycle.test.ts`  
Expected: FAIL because the shared host and runtime health do not exist.

- [ ] **Step 3: Implement `MorrowRuntimeHost`**

Implement explicit configuration and ownership:

```ts
export interface MorrowRuntimeConfig {
  dbPath: string; homeDir: string; secretsFile: string; host: string; port: number;
  legacyDbPaths: string[]; env: NodeJS.ProcessEnv; webRoot?: string;
  schedulerEnabled: boolean; backgroundModelCatalog: boolean; tokenizerWarmup: boolean;
}
export interface MorrowRuntimeHost {
  listen(): Promise<string>;
  close(): Promise<void>;
  status(): RuntimeCapabilityStatus;
}
export async function createMorrowRuntimeHost(config: MorrowRuntimeConfig, overrides?: RuntimeHostOverrides): Promise<MorrowRuntimeHost>;
```

The host owns secret hydration, migration, database, supervisor, catalog, runner, controller, work graphs, reconciliation, server, scheduler, poller, tokenizer warm-up, and reverse-order cleanup. Keep factories injectable only at owning boundaries required by deterministic tests.

- [ ] **Step 4: Make health a callback over authoritative host state**

Add a strict shared contract and `runtimeStatus?: () => RuntimeCapabilityStatus` to `ServerDependencies`:

```ts
export const RuntimeCapabilityStatusSchema = z.object({
  version: z.literal(1),
  startupReconciled: z.boolean(),
  workGraphs: z.enum(["ready", "degraded", "not_managed"]),
  scheduler: z.enum(["running", "disabled", "degraded", "not_managed"]),
  skills: z.object({
    healthy: z.boolean(), entries: z.number().int().nonnegative(),
    loadable: z.number().int().nonnegative(), issues: z.number().int().nonnegative(),
  }).strict(),
}).strict();
```

Make `HealthSchema.runtime` required. The health route reports the callback result and defaults to explicit `startupReconciled: false`, `not_managed` component values for direct unit-test server construction; it never fabricates readiness.

- [ ] **Step 5: Collapse both entrypoints onto the host**

Replace `services/orchestrator/src/index.ts` with environment/config resolution, `createMorrowRuntimeHost`, `listen`, logging, and signal handling. Replace the construction block in `serveForeground` with the same host factory while preserving dynamic import and existing credential-shadow messaging. Both entrypoints call the host's idempotent `close()` on termination.

- [ ] **Step 6: Run host GREEN and startup regression gates**

Run:

`pnpm --filter @morrow/orchestrator test -- runtime-host.test.ts api.test.ts work-graph-production-integration.test.ts mission-controller-restart.test.ts schedules.test.ts && pnpm --filter @morrow/cli test -- service-lifecycle.test.ts service-entry-match.test.ts`

Expected: PASS.

- [ ] **Step 7: Measure CLI light-command startup**

Run the repository's established startup benchmark before and after the host wiring using `pnpm --filter @morrow/orchestrator benchmark:startup`; record `morrow --version` and service-start medians in the task report. `morrow --version` must remain within the benchmark's existing tolerance because the host remains dynamically imported.

- [ ] **Step 8: Typecheck and commit runtime composition**

Run: `pnpm --filter @morrow/orchestrator check && pnpm --filter @morrow/cli check`  
Commit: `refactor(runtime): unify production startup composition`

---

### Task 5: Canonical scheduled transitions, integration gates, and durable documentation

**Files:**
- Modify: `services/orchestrator/src/schedule/ticker.ts`
- Modify: `services/orchestrator/test/schedules.test.ts`
- Create: `scripts/check-task-status-authority.mjs`
- Modify: `scripts/validate-repository.mjs`
- Create: `scripts/check-task-status-authority.test.mjs`
- Modify: `docs/architecture.md`
- Create: `docs/decisions/0018-authoritative-runtime-and-skill-lifecycle.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: canonical `taskRecordsRepository.transitionTask` and Tasks 1-4 runtime/catalog behavior.
- Produces: durable `task.failed` event for a created scheduled task whose dispatch fails.
- Produces: static repository guard against production `updateTaskStatus` callers.

- [ ] **Step 1: Add scheduled-failure RED tests**

Extend `schedules.test.ts` with two exact cases:

1. Task creation succeeds and `runner.run` throws: task becomes `failed`, has one `task.failed` event containing `scheduleId` and a redacted safe message, and `next_run_at` remains due.
2. Task creation throws before a task exists: schedule remains due and no task/event row is fabricated.

Run: `pnpm --filter @morrow/orchestrator test -- schedules.test.ts`  
Expected: FAIL because the current catch performs a raw status update without an event.

- [ ] **Step 2: Transition through the canonical facade**

Replace the raw call with:

```ts
const task = tasks.getTaskById(taskId);
if (task?.status === "queued" || task?.status === "running") {
  taskRecordsRepository(this.deps.db).transitionTask(taskId, "failed", {
    id: randomUUID(),
    createdAt: nowIso,
    payload: { scheduleId: schedule.id, message: safeScheduleError(error) },
  });
}
```

Keep schedule retry semantics unchanged. Redact/truncate the error through an existing safe-text helper or a focused local equivalent capped at 1000 characters.

- [ ] **Step 3: Add and prove the static authority guard**

Create a repository script that scans production TypeScript under `services/orchestrator/src` and fails when `.updateTaskStatus(` occurs outside `repositories/tasks.ts` and the documented sample fixture. Add negative/positive tests using temporary fixture trees.

Run: `node --test scripts/check-task-status-authority.test.mjs`  
Expected: PASS after first observing the negative fixture fail through the checker API.

- [ ] **Step 4: Run focused and package verification**

Run:

`pnpm --filter @morrow/orchestrator test -- schedules.test.ts scheduled-routines.test.ts recovery.test.ts runtime-host.test.ts skill-catalog.test.ts api.test.ts skill-install-api.test.ts agent-install-skill.test.ts agent-loop.test.ts`

Then run:

`pnpm --filter @morrow/contracts test && pnpm --filter @morrow/orchestrator test && pnpm --filter @morrow/cli test && pnpm --filter @morrow/web test`

Expected: all deterministic package suites PASS after the last production/client change.

- [ ] **Step 5: Run repository checks and build**

Run: `pnpm check && pnpm build && node scripts/validate-repository.mjs`  
Expected: PASS.

- [ ] **Step 6: Record verified architecture and user-visible behavior**

Update architecture and ADR 0018 with the shared composition root, catalog authority, migration 73, fail-closed defaults, failure behavior, privacy/security impact, rollback, and the exact verification commands/results. Add concise `[Unreleased]` changelog bullets only for behavior actually proven.

- [ ] **Step 7: Independent security review and repair loop**

Provide the full branch diff to a separate Luna Max reviewer. Require explicit review of activation bypasses, path disclosure, duplicate-ID ambiguity, install rollback, scheduler duplication, shutdown races, transition/event truth, and migration behavior. Return every Critical/Important finding to the owning implementer, rerun covering tests, and obtain a scoped clean re-review.

- [ ] **Step 8: Commit the verified tranche**

Commit: `fix(runtime): make lifecycle state authoritative`

The tranche is complete only after a final whole-branch review confirms spec compliance and code quality, and all resulting fixes are reverified.
