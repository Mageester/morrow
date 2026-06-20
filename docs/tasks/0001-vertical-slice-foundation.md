# Task 0001 — Executable Vertical Slice Foundation

- **Issue:** #7
- **Branch:** `feat/vertical-slice-foundation`
- **Status:** Ready for implementation
- **Owner:** Codex, reviewed by Aidan

## Mission

Build Morrow's first runnable end-to-end experience. This is an architecture proof and product-quality foundation, not a demo full of fake integrations.

The vertical slice must let a user create a local project, run a deterministic read-only `Inspect workspace` task, watch a plan and ordered activity stream, inspect privacy and execution evidence, restart the orchestrator, and recover the task history.

## Read first

1. `AGENTS.md`
2. `docs/product-vision.md`
3. `docs/architecture.md`
4. `docs/privacy-model.md`
5. `docs/design-principles.md`
6. GitHub issue #7

## Implementation constraints

Use:

- TypeScript
- pnpm workspaces
- React + Vite in `apps/web`
- Fastify in `services/orchestrator`
- Zod schemas in `packages/contracts`
- SQLite under `.morrow/`
- Server-Sent Events for live activity
- Vitest for unit and integration tests

Do not add real model providers, terminal execution, browser automation, authentication, remote access, memory retrieval, plugins, skills, MCP, messaging, agent teams, deployment, or desktop packaging.

## Required domain objects

At minimum, define versioned contracts for:

- Project
- Task
- PlanStep
- TaskEvent
- TaskEvidence
- ExecutionDisclosure
- VerificationResult

Use explicit enums or discriminated unions for task and event states. Avoid stringly typed internal protocols.

## Required API behavior

Provide endpoints for:

- Health
- Create/list/get projects
- Create/list/get tasks
- Retrieve task events and evidence
- Subscribe to ordered task events over SSE

Document API errors and status codes. Validate all input at the boundary.

## Built-in task

`Inspect workspace` must:

1. Validate the configured workspace.
2. Create a persisted three-step plan.
3. Recursively list a safe, bounded set of workspace files.
4. Record each returned relative path as evidence.
5. Produce a deterministic verification result.
6. Complete without a network request or shell execution.

The file tool must reject traversal and symlink escape. Add reasonable limits for recursion depth and result count, and surface truncation honestly.

## Required interface

Create a restrained application shell with:

- Left navigation: Today, Conversations, Projects, Agents, Automations
- Main canvas: project creation, project selection, task submission, task result
- Right inspector: plan, live activity, privacy disclosure, files accessed, verification

Required states:

- Empty
- Ready
- Running
- Failed
- Verified

Accessibility requirements:

- Semantic controls
- Keyboard navigation
- Visible focus treatment
- Appropriate labels and status announcements
- Reduced-motion support

## Persistence and recovery

Projects, tasks, plans, events, disclosures, evidence, and verification results must persist in SQLite.

On restart:

- Completed and failed tasks remain available.
- An interrupted running task transitions to a documented recoverable state rather than disappearing or incorrectly reporting success.
- Event ordering remains stable.

## Tests

Implement tests for:

- Contract validation
- Persistence and repository behavior
- Restart recovery
- Ordered SSE events
- Workspace boundary enforcement
- `..` traversal rejection
- Symlink escape rejection where supported
- Bounded file listing
- Successful end-to-end task

## Completion procedure

1. Run `pnpm install`.
2. Run `pnpm check`.
3. Run `pnpm test`.
4. Run `pnpm build`.
5. Run the app and capture screenshots of empty, running, and verified states.
6. Update documentation with setup, architecture notes, known limitations, and exact commands.
7. Commit focused changes using Conventional Commits.
8. Push only to `feat/vertical-slice-foundation`.
9. Open a **draft** pull request to `main` that closes #7.
10. Do not merge.

## Required final report

Include:

- Summary of architecture
- Files and packages added
- Commands run and exact results
- Test coverage and failure cases checked
- Privacy and security impact
- Known limitations
- Screenshots
- Suggested next task
