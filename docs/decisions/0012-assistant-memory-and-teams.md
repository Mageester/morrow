# ADR-0012: Private assistant profile, scoped memory vault, and agent teams

**Status:** Accepted for prerelease implementation
**Date:** 2026-08-11

## Context

Morrow's mission called for a private personal assistant, persistent named
agent teams with safe delegation, and consumer polish — built as one
trustworthy loop, not three disconnected screens. An earlier, unactioned
handoff prompt
([docs/prompts/claude-private-assistant-teams-consumer-polish.md](../prompts/claude-private-assistant-teams-consumer-polish.md))
proposed contracts for this — a `personal/project/agent/team/task/ephemeral`
memory-scope taxonomy and a four-mode privacy taxonomy
(`Local only/Private/Project/Web enabled`) — that do not match what Morrow
already ships. `docs/privacy-model.md` already defines exactly three privacy
modes (`Local only`/`Controlled cloud`/`Custom`), and `MemoryScopeSchema`
already defines a richer fifteen-value scope enum. Persistent named agents
and a shallow parent/child task-graph subagent mechanism already existed
(`services/orchestrator/src/repositories/agents.ts`,
`POST /api/tasks/:taskId/subagents`), but no `Team` concept existed anywhere,
and the subagent route bypassed real provider dispatch entirely.

## Decision

Extend the shipped system rather than fork a second taxonomy:

- **Memory scopes**: widen the existing `MemoryScopeSchema` enum with two new
  values, `agent` and `team`. The prompt's `personal` scope maps onto the
  already-shipped `user_global` scope (the one scope explicitly allowed to
  cross project boundaries — every other scope stays strictly
  project-isolated, unchanged); `task` maps onto the already-shipped
  `temporary_context`. `ephemeral` is deliberately **not** a persisted scope
  at all — request-only context must never reach `memory_entries`, so it has
  no row shape.
- **Privacy modes**: a new `PrivacyModeSchema` (`local_only`/
  `controlled_cloud`/`custom`) matching `docs/privacy-model.md` exactly. The
  prompt's fourth mode, "Web enabled," is implemented as a per-agent tool
  permission (browser/web tools allow/deny on `AgentToolPermission`), not a
  fourth privacy mode — it composes with any privacy mode instead of forking
  a second taxonomy.
- **Assistant profile**: a single local, cross-project row (`assistant_profile`,
  singleton id `"default"`) — the one entity in Morrow that is deliberately
  not project-scoped. User-authored fields are direct writes; any
  model-suggested fact becomes a `candidate`-lifecycle `memory_entries` row
  in `user_global` scope requiring explicit approval before it is ever shown
  as part of the profile, reusing the existing memory lifecycle state
  machine instead of inventing a second provenance mechanism.
- **Teams**: one preset only, `research_and_verify` (`Researcher` +
  `Verifier`), materialized as real `agents` rows with a new `team_id`
  foreign key, memory-scope read/write lists, budget fields, and an
  `approval_required` flag — all additive nullable/defaulted columns
  (migration 47), so a standalone agent with no team keeps working exactly
  as before.
- **Delegation & handoff**: new `delegations`/`handoffs` tables (migration
  48). Every field that could widen authority — status, budget,
  allowedTools, allowedMemoryScopes, approvalRequired — is computed
  server-side from the team/agent policy intersection at delegation-creation
  time; `CreateDelegationSchema` has no such fields, so a client cannot
  submit them even by accident. A DB-level partial unique index
  (`delegations_one_running_per_child`) enforces at most one running
  delegation per child task, matching the existing
  `agent_execution_segments_one_running` reservation pattern. Resolving an
  already-resolved delegation returns 409, not a second spawn — a replayed
  approval after a crash/restart cannot duplicate a delegation.
- **Real dispatch, not a bypass**: `SpawnSubagentSchema.kind` gained
  `"agent_chat"`, and that path now routes through `dispatchAgentTask`
  (fresh, minimal child conversation — never the parent's full history) so a
  delegated child gets real provider routing, conversation linkage, and
  agent-state events. `kind:"inspect_workspace"` keeps its exact original
  code path, regression-guarded by the existing `subagents.test.ts` suite.
- **Deterministic sample task**: "Summarize this project's README" runs the
  full Researcher → Verifier → handoff loop with zero live provider calls —
  Researcher reads `README.md` and produces a bounded, deterministic
  extract-based summary (first heading + first paragraph, not an LLM call);
  Verifier runs bounded checks (non-empty, cites the source) before a
  handoff is recorded. A missing/empty README refuses outright
  (`ReadmeSummarySampleError`) rather than fabricating a summary — zero
  evidence never renders as a completed result.

## Consequences

- Ten deterministic, no-network acceptance tests
  (`services/orchestrator/test/security-acceptance.test.ts`) directly prove
  the mission's ten numbered security/privacy criteria — cross-project
  memory isolation, agent scope enforcement, no self-expanding child
  authority, cancellation propagation, no duplicate delegation on
  replay, prompt-injection resistance (memory content cannot grant tool
  permissions), zero external requests in local-only/mock mode,
  secret-redacted sharing previews, safe forget/delete, and no
  scope-widening export/import.
- **Runtime policy invariant**: `AgentToolPermission`/`getEffectiveToolPermission`
  rows are created and inspectable (the user can see a team's effective
  policy before it runs). The runtime now intersects durable tool permissions,
  memory read/write scopes, approval posture, and the tighter agent/delegation
  budgets. Tool definitions are filtered before they reach the provider, and
  the same policy is checked again immediately before any tool side effect or
  memory read. Budget exhaustion interrupts the task with durable evidence
  rather than silently widening execution.
- **Residual local-auth boundary**: the local orchestrator process is the
  authority for project ownership and delegation context. Remote or
  multi-user authentication is outside this local-first slice and must be
  added before exposing these routes beyond the trusted local process.
- The `/subagents` route now special-cases `kind:"agent_chat"`; any future
  change to `dispatchAgentTask`'s signature must keep the `parentTaskId`
  passthrough additive-only.
- Migrations 47–49 are purely additive (new tables, nullable/defaulted
  columns) — no CHECK-constraint rebuilds, no destructive change to existing
  agent/memory/task data.

## Alternatives rejected

- **Adopting the prompt's memory-scope and privacy-mode names verbatim**: it
  would fork a second taxonomy alongside the shipped one, guaranteeing drift.
  Extending the shipped enums is a smaller, safer diff and keeps one source
  of truth.
- **Routing delegated children through the live agent execution loop with a
  scripted provider transcript** (matching `benchmarks/harness-economics/deterministic.ts`'s
  convention): rejected for the sample task specifically — it would require
  new multi-tool-call scripted transcripts driving the same execution engine
  used for real live traffic, a materially larger and riskier change than a
  standalone deterministic function for proving one bounded vertical slice.
  The heavier, execution-engine-integrated approach remains available for a
  future slice once live-provider delegation is in scope.
- **A new Task.kind value for the deterministic sample flow**: rejected in
  favor of reusing the existing `agent_chat` kind with statuses driven
  directly (not through the runner), keeping the `TaskSchema.kind` enum's
  blast radius unchanged.
- **Graduating `settings-page.tsx` into a new `features/settings/` module**:
  deferred; the Assistant Profile and Privacy sections were added in place
  to the existing page instead, matching its established inline-style
  convention and avoiding a larger, riskier restructure of an
  already-working page in the same change.
