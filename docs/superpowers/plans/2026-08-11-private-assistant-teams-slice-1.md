# Plan: Private assistant, agent teams, and consumer polish — slice 1

> **Record of an executed plan**, kept in the same RED/GREEN/Verify format the implementation agent used. See [docs/decisions/0012-assistant-memory-and-teams.md](../../decisions/0012-assistant-memory-and-teams.md) for the design decision this plan implements, and the design/spec presented to and approved by the user before implementation began.

**Goal:** One deterministic, inspectable vertical loop — a private assistant profile, a `research_and_verify` agent team, delegation with a durable handoff, and the web surfaces to see it — proven by the mission's ten numbered security/privacy acceptance criteria.

**Scope:** `packages/contracts`, `services/orchestrator` (migrations 47–49, repositories, routes), `benchmarks/harness-economics`, and `apps/web` (Memory/Teams routes, Settings additions, onboarding, Home sample-task runner). No live provider, no encryption, no routine scheduler, no additional team presets — see ADR-0012 for the full deferred list.

**Safety boundary:** local SQLite (`:memory:` in tests) and local fixtures only; the deterministic sample task never constructs an `AiProvider`. No credentials inspected, no live provider called, nothing staged/committed/pushed.

## Slice 1.1 — Contracts

**RED:** `packages/contracts/test/teams.test.ts` (27 cases) importing `AssistantProfileSchema`, `TeamSchema`, `DelegationSchema`, `HandoffSchema`, and the widened `MemoryScopeSchema`/`AgentSchema`/`SpawnSubagentSchema`/`ExecutionDisclosureSchema` — none existed yet.

**GREEN:** New `packages/contracts/src/teams.ts`; additive extensions to `index.ts` (two new `MemoryScope` values, `Agent` team/budget/scope fields, `SpawnSubagentSchema.kind` `"agent_chat"`, `ExecutionDisclosureSchema` preview fields). Hit and fixed a same-package circular-import bug (`teams.ts` importing runtime values from `index.ts`, which re-exports `teams.ts` — the dependency is evaluated *before* `index.ts`'s own top-level code runs) via `z.lazy()` indirection.

**Verify:** `packages/contracts` — 80/80 tests, clean `tsc`. Rebuilt `dist/` (package `exports` resolve there, not `src/`, for every downstream consumer) — this rebuild-after-contract-change step recurred throughout and is worth remembering for future sessions.

## Slice 1.2 — Orchestrator persistence

**RED:** `services/orchestrator/test/teams-and-delegation.test.ts` (14 cases) against `teamsRepository`/`delegationsRepository`/`handoffsRepository`/`assistantProfileRepository` — none existed.

**GREEN:** Migrations 47–49 (append-only; confirmed `memory_entries.scope` has no DB-level CHECK constraint, so the scope widening needed zero migration). Four new repositories plus `agentsRepository`/`memoryRepository` extensions (`listByScope`, `listUserGlobal` — the one query that deliberately crosses project boundaries, and only for `user_global`).

**Verify:** 183 files / 2010 tests, clean `tsc`, across every subsequent step in this slice.

## Slice 1.3 — Routes and real dispatch

**RED:** `services/orchestrator/test/subagents.test.ts` extended (agentId required/404/real-dispatch cases); `services/orchestrator/test/teams-api.test.ts` (22 cases) for `/teams`, `/delegations`, `/assistant-profile`, memory scope-filter and export/import.

**GREEN:** `POST /api/tasks/:taskId/subagents` with `kind:"agent_chat"` now routes through `dispatchAgentTask` (`parentTaskId` threaded through as an additive field) instead of the bare `runner.run` shortcut; `kind:"inspect_workspace"` untouched. Full Teams/Delegations/Handoffs/AssistantProfile route surface, plus `/memory?scope=` and `/memory/export|import`.

**Verify:** subagents 9/9, teams-api 13/13 (later 22 with memory routes).

## Slice 1.4 — Security acceptance

**RED:** `services/orchestrator/test/security-acceptance.test.ts`, one case per mission-numbered criterion (1–10).

**GREEN:** New `security/agent-memory-policy.ts` (`canAgentAccessMemoryScope`); delegation `/resolve` idempotency guard (409 on a second approve — a replayed request cannot spawn a second child); `/cancel` now propagates to the child task via `deps.runner.cancel`; `memoryRepository.exportEntries`/`importEntries` (re-scopes to the importing project, skips `agent`/`team` scoped rows, forces `source:"user"`). One assumption corrected mid-cycle: criterion 7's "local-only, zero network" proof initially assumed a `deterministic-local` provider descriptor that does not exist in the runtime registry — switched to the real `mock` provider gated by `MOCK_PROVIDER=true`.

**Verify:** 10/10 acceptance cases green; 182 files / 2003 tests full suite.

## Slice 1.5 — Deterministic sample task and benchmark

**RED:** `services/orchestrator/test/readme-summary-sample.test.ts` (6 cases: determinism, bounded excerpt, no-heading fallback, full end-to-end proof, refuses on missing README, reusability).

**GREEN:** `mission/readme-summary-sample.ts` — pure `summarizeReadme` (first heading + first paragraph, bounded, no model call) plus `runReadmeSummarySample`, which runs the Researcher → Verifier → handoff loop directly against the durable repositories (not through the live agent-execution loop — see ADR-0012's alternatives-rejected). `POST /api/projects/:id/sample-tasks/readme-summary` exposes it. New `benchmarks/harness-economics/delegation-scenario.ts` (separate file from the existing `deterministic.ts`/`run.ts`, which are untracked owner files this session did not touch) appends `delegation-evidence-2026-08-11.jsonl` — 3 runs, 3 passed, 0 provider calls (exact, not estimated).

**Verify:** 6/6 new tests; 183 files / 2010 tests full suite; benchmark script run confirmed real JSONL/summary/SVG output.

## Slice 1.6 — Web

**RED/GREEN, per surface:**
- `apps/web/src/features/shared/result-state.ts` (6 tests) — the six honest result states, mapped from delegation status + acceptance-criteria outcome.
- `features/teams/teams-page.tsx` + `features/memory/memory-page.tsx` (4 component tests) — new `/teams`, `/memory` routes; `Memory` nav item graduated from `upcoming:true` to a real route; `Teams` added to nav.
- `features/placeholders/settings-page.tsx` extended in place (2 tests) with Assistant Profile + Privacy-mode sections — kept in place rather than graduated to `features/settings/`, to avoid a larger, riskier restructure of an already-working page (see ADR-0012).
- `features/onboarding/getting-started.tsx` — two new optional steps (privacy mode, team creation); existing test suite updated for the new nav/route shape.
- `features/home/home-page.tsx` — `SampleTaskSection` runs the deterministic delegation and renders the real acceptance-criteria/evidence, not a "done" toast.
- `app-shell.test.tsx` updated: `/memory` is a real route now, so its former "unrecognised address" test case moved to a genuinely nonexistent path.

**Verify:** 40 files / 291 tests, clean `tsc`, across `apps/web`.

## Final verification

`pnpm test`/`pnpm check`/`pnpm build` per package as each slice landed (see the per-slice Verify notes above); full `pnpm test`/`pnpm check`/`pnpm build`/`git diff --check` at the repository root before considering the slice done. Manual pass in the running dev app (`http://localhost:4318/app/` + `http://localhost:4317`) for onboarding, `/memory`, `/teams`, Settings, and the full README-summary delegation flow. Left all changes unstaged and uncommitted; did not push, merge, stage, or open a pull request.
