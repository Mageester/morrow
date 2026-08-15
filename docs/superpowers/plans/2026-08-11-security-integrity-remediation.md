# Security and Integrity Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the validated delegation, memory, handoff, lifecycle, and deterministic-sample integrity defects while preserving existing local-first agent behavior.

**Architecture:** Keep the existing Fastify, SQLite, repository, and execution boundaries. Derive one immutable runtime policy from the task's agent and approved delegation, enforce it both when tools are exposed and immediately before tool dispatch, filter memory at the repository boundary, and make every delegation/handoff API operation prove its parent/project relationship. Deterministic sample work will validate evidence before durable success and clean up all rows on precondition failure.

**Tech Stack:** TypeScript, Fastify, Zod, SQLite/better-sqlite3, Vitest, pnpm/Turbo, real `app.inject` and local HTTP API harnesses.

## Global Constraints

- Preserve unrelated user changes and do not inspect or modify the protected prototype UI files listed in `AGENTS.md`.
- Do not stage `messages.json`, screenshots, live-provider snapshots, or benchmark artifacts unless they are independently proven to belong to this remediation.
- Keep local-first behavior and existing standalone agents working when no team policy is configured.
- Every production behavior change gets a regression test written and observed failing before its implementation.
- Never accept policy, budget, status, project identity, artifact proof, or agent/team identity from model output or an untrusted client body when the server can derive it.
- Use deterministic providers and real repository/API boundaries for tests; do not require external credentials or network access.

---

### Task 1: Runtime agent policy boundary

**Files:**
- Create: `services/orchestrator/src/security/agent-execution-policy.ts`
- Modify: `services/orchestrator/src/repositories/agents.ts`
- Modify: `services/orchestrator/src/repositories/delegations.ts`
- Modify: `services/orchestrator/src/mission/task-dispatcher.ts`
- Modify: `services/orchestrator/src/execution/agent.ts`
- Test: `services/orchestrator/test/agent-execution-policy.test.ts`
- Test: `services/orchestrator/test/agent-loop.test.ts`

**Interfaces:**
- `buildAgentExecutionPolicy(agent, delegation?)` returns the server-derived allowed tool effects, readable memory scopes, writable memory scopes, approval posture, and numeric ceilings.
- `isToolAllowed(policy, toolName)` and `isMemoryScopeAllowed(policy, scope, mode)` are pure decisions used by both tool exposure and dispatch/memory reads.
- Approved delegation policy is loaded by child task ID; direct `agent_chat` children use the agent's own policy and cannot inherit a team scope without an approved delegation row.

- [ ] Write a failing test proving a researcher child cannot expose or execute `run_command` or `create_file`, while `read_file` remains available.
- [ ] Write a failing test proving a child with no `team` delegation cannot read `team` memory, and a verifier child with approved delegation can read only its persisted allowed scopes.
- [ ] Write a failing test proving direct `agent_chat` spawning still works for a standalone agent but honors its explicit deny policy.
- [ ] Run the focused tests and confirm the new assertions fail because the existing execution path ignores agent policy.
- [ ] Implement the policy helper and load policy from the task's agent plus its approved/running delegation.
- [ ] Filter provider tool definitions by policy and add a defense-in-depth denial before any approval record, filesystem operation, process launch, browser operation, or other tool dispatch.
- [ ] Filter `retrieveRelevant` results for the current task's readable scopes without changing ordinary non-agent tasks.
- [ ] Preserve existing mode restrictions and approval behavior; agent policy denial must be recorded as a bounded tool failure, never turned into an approval prompt.
- [ ] Run the focused policy and agent-loop tests, then run the owning orchestrator test file.

### Task 2: Delegation object/project authorization and lifecycle

**Files:**
- Modify: `packages/contracts/src/teams.ts`
- Modify: `apps/web/src/api/teams.ts`
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/src/repositories/teams.ts`
- Test: `packages/contracts/test/teams.test.ts`
- Test: `services/orchestrator/test/teams-api.test.ts`
- Test: `services/orchestrator/test/security-acceptance.test.ts`

**Interfaces:**
- Delegation detail/mutation requests carry a required `parentTaskId` access context; the server verifies it matches the durable delegation parent and that the parent, team, agent, and child all belong to one project.
- Team delegation creation requires `team.status === "active"`, `agent.enabled === true`, agent/team project equality, and actual membership.
- Handoff target agents must be enabled members of the same team and project.

- [ ] Add API tests for ownerless/wrong-parent detail, resolve, cancel, and handoff requests; assert 404/403 without changing state.
- [ ] Add API tests rejecting draft, paused, or archived teams and disabled/non-member agents.
- [ ] Add a positive API flow using the required parent context so existing UI-shaped behavior remains valid.
- [ ] Run the focused API tests and confirm they fail against identifier-only routes and missing lifecycle checks.
- [ ] Implement narrow request schemas and a shared server helper that resolves and authorizes a delegation against its parent task/project/team/agent.
- [ ] Update the web API wrappers to pass the parent task context while preserving their public method purpose.
- [ ] Validate handoff target membership and reject unknown or cross-project targets before persistence.
- [ ] Run contracts and API-focused tests.

### Task 3: Memory import integrity

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/src/repositories/memory.ts`
- Test: `packages/contracts/test/teams.test.ts`
- Test: `services/orchestrator/test/teams-api.test.ts`
- Test: `services/orchestrator/test/security-acceptance.test.ts`

**Interfaces:**
- Import accepts the exported memory-entry shape only after Zod validation, while server-side import normalization still ignores source/project/lifecycle/provenance fields.
- `memoryRepository.importEntries` validates each normalized entry before insertion and uses a transaction so a malformed batch produces no partial rows.

- [ ] Add a failing HTTP test posting invalid scope/type and assert status 400 plus zero persisted rows.
- [ ] Add a failing batch test where one valid entry precedes one invalid entry and assert atomic no-partial-write behavior.
- [ ] Add a positive round-trip test for a valid exported user memory and explicit skipping of agent/team scopes.
- [ ] Run focused tests and observe current 400-with-row-persisted behavior.
- [ ] Add the narrow import schema and move validation ahead of `create` inside an SQLite transaction.
- [ ] Re-run the focused API and repository tests.

### Task 4: Handoff proof and deterministic sample correctness

**Files:**
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/src/mission/readme-summary-sample.ts`
- Modify: `services/orchestrator/src/repositories/handoffs.ts`
- Modify: `services/orchestrator/src/repositories/delegations.ts`
- Test: `services/orchestrator/test/teams-api.test.ts`
- Test: `services/orchestrator/test/readme-summary-sample.test.ts`

**Interfaces:**
- Handoff validation recomputes acceptance criteria and artifact hashes from the child task's durable evidence/workspace before completing a delegation.
- The README sample checks the literal source path and hashes the actual README artifact; missing/empty input rolls back all sample-created team, task, delegation, and evidence rows.

- [ ] Add a failing handoff test using a fake artifact hash, foreign target agent, and unmet criterion; assert rejection and unchanged running delegation.
- [ ] Add a failing sample test with a README whose content does not literally prove the source criterion; assert failure rather than completed handoff.
- [ ] Add a failing sample test with no README and assert no active team, pending delegation, or failed task residue remains.
- [ ] Run focused tests and confirm the current caller-forged proof and durable residue.
- [ ] Implement server-side handoff evidence checks using existing task/evidence/workspace repositories, keeping legitimate deterministic handoffs green.
- [ ] Wrap sample setup and execution in a transaction or explicit compensating cleanup that preserves the thrown error while removing all partial durable state.
- [ ] Run focused sample and handoff tests.

### Task 5: Agent/team project integrity

**Files:**
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/src/repositories/agents.ts`
- Test: `services/orchestrator/test/teams-api.test.ts`
- Test: `services/orchestrator/test/security-acceptance.test.ts`

- [ ] Add a failing test proving agent create/update rejects a team from another project and that the agent's stored team ID remains unchanged.
- [ ] Implement repository/server validation using the durable team project and membership relationship.
- [ ] Run focused tests and check adjacent agent CRUD behavior remains intact.

### Task 6: Real API validation, full verification, and release

**Files:**
- Modify: `docs/privacy-model.md` if the enforcement boundary changes user-visible behavior.
- Modify: `docs/decisions/0012-assistant-memory-and-teams.md` with the verified policy invariant and residual local-auth boundary.

- [ ] Run the deterministic `app.inject` suite against the real Fastify server and a separate local HTTP server with `curl`/Node `fetch` for create, reject, approve, deny, import, handoff, and cleanup paths.
- [ ] Run `pnpm test`, `pnpm check`, `pnpm build`, and `git diff --check` from the final working tree.
- [ ] Run rendered desktop/mobile browser smoke tests for the changed API-backed routes and confirm zero browser console errors.
- [ ] Inspect the final diff and stage only the remediation files; leave protected UI changes and unrelated artifacts unstaged.
- [ ] Update the package version from `0.1.0-beta.40` to the next release version only if the release metadata and focused diff are coherent.
- [ ] Commit with a focused Conventional Commit, push the current branch with tracking, and create the GitHub release/draft PR with test evidence and rollback notes.

