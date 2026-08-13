# AI Agent Working Agreement

This file governs AI coding agents working in the Morrow repository.

## Mission

Build Morrow as a direct, privacy-focused alternative to Hermes Agent. Morrow must preserve practical agent capabilities while providing a cleaner experience, deeper customization, better reliability, persistent agent teams, understandable privacy, and evidence-backed superiority.

Morrow is an AI agent application. Do not reframe it as an operating system, enterprise control plane, generic dashboard, or unrelated SaaS platform.

## Before changing code

1. Read `README.md` and the relevant files in `docs/`.
2. Identify the issue or acceptance criteria being addressed.
3. Inspect existing interfaces before introducing a new abstraction.
4. State assumptions in the pull request when requirements are incomplete.
5. Prefer the smallest coherent change that advances a milestone.

## Required behavior

- Work on a dedicated branch.
- Keep commits focused and use Conventional Commit messages.
- Add or update tests for behavior changes.
- Run all available checks before reporting completion.
- Include evidence: commands run, tests passed, screenshots where relevant, and known limitations.
- Update architecture records when changing a major boundary or invariant.
- Preserve local-first behavior and provider choice.
- Keep the default experience simple while exposing advanced controls progressively.

## Integration discipline

`main` is the single integration branch. Everything reconciles onto it, and
nothing else is allowed to become a second long-lived line.

- Rebase or merge `main` into your branch daily once it is more than a week
  behind, and always before requesting a merge. CI enforces this
  (`scripts/check-branch-freshness.mjs`): a pull request whose merge-base is
  more than seven days of integration history old fails.
- Anything touching `services/orchestrator/src/{execution,provider,web}` is
  held to that window strictly. Those are the files two parallel lines both
  edit, and the merge that unified them produced defects with no conflict
  marker to warn anyone.
- Delete a branch once it merges. `node scripts/branch-inventory.mjs`
  regenerates `docs/branch-inventory.md`, which separates merged branches from
  abandoned ones so the backlog can be cleared deliberately.
- Two agents must not work parallel long-lived branches over the same
  subsystem. If that is unavoidable, land the first before starting the second.

This is not a style preference. `morrow/consumer-polish` and `main` diverged
for a week at 88 and 70 commits, and the reconciliation silently merged two
unrelated functions that happened to share a name (caught only because `tsc`
complained — a rename would have hidden it) and dropped a fix that had already
shipped once in beta.34.

## Prohibited behavior

- Do not commit secrets, API keys, tokens, credentials, private messages, or personal data.
- Do not bypass permissions or approval boundaries for convenience.
- Do not add telemetry, analytics, external inference, or hosted dependencies silently.
- Do not claim a capability is complete without a test or reproducible demonstration.
- Do not copy code from Hermes or another project without verifying its license and preserving required attribution.
- Do not let the same agent author, approve, and merge a security-sensitive change.
- Do not merge directly to `main`.
- Do not introduce broad frameworks or integrations before the current vertical slice is stable.

## Security-sensitive areas

Changes touching any of the following require explicit security review:

- Tool permissions and approvals
- Terminal, filesystem, browser, or computer control
- Secrets and credentials
- Memory storage or retrieval
- Model-provider requests and external data flow
- Scheduled or unattended execution
- Authentication and remote access
- Plugin, skill, MCP, or extension loading

## Definition of done

A change is complete only when:

- Acceptance criteria are satisfied.
- Relevant tests pass.
- Failure behavior has been considered.
- User-visible behavior is documented.
- Privacy and security impact is recorded.
- The pull request includes evidence and rollback notes.

## Core Design Principles

The project must strictly follow modular design.

Each module should have:

- A clear responsibility.
- A clear interface.
- Minimal unnecessary coupling.
- A structure that makes it easy to test, debug, replace, extend, and reuse.

Nested modules are allowed when they make responsibilities clearer. Avoid placing unrelated responsibilities into the same file, class, service, or large function.

- Define proportionate acceptance and verification requirements before implementation.
- Keep related tests cohesive enough to avoid fragmented micro-tests, but never reduce meaningful coverage, weaken assertions, or hide failures merely to save tokens or execution time.

## Tool Execution and Batching

For each bounded work stage, identify independent, already-known, non-conflicting tool calls before invoking tools. When practical, execute them through one outer `functions.exec` or Code Mode `exec` call.

Use `Promise.allSettled()` when successful results remain useful even if another call fails. Inspect and attribute every returned result. Use `Promise.all()` only when any individual failure invalidates the entire batch.

Prefer batching for:

- Read-only file inspection.
- Independent symbol, text, and call-site searches.
- Repository metadata and status collection.
- Independent log or artifact inspection.
- Validation commands that do not share mutable state.

Keep operations sequential when they involve:

- A result that determines the next operation.
- Adaptive investigation where the next target is not yet known.
- Approvals or permission boundaries.
- Agent spawn, wait, resume, message, or replacement operations.
- Overlapping or order-sensitive writes.
- Git staging, commits, resets, or other Git-state mutations.
- Builds or tests sharing a build directory, generated output, database, port, fixture, device, or other mutable resource.

Do not split an otherwise batchable inspection across repeated outer tool calls. Do not create extra work, broaden scope, obscure failure attribution, or increase worker count merely to fill a batch.

Tool-call concurrency is local to one agent thread. It does not change route selection, worker ownership, scope boundaries, verification requirements, or subagent-concurrency limits. A stage requiring only one useful tool call should remain one call.

## Working State

At any given time, we will be in one of two working states:

- `deployment state`: beginning to plan a broad task or in the process of deploying a plan. A deployment plan can span multiple sessions.
- `leaf state`: for tasks outside the plan being deployed by the `deployment state`, such as general queries, document editing, or performing operations to add, modify, or delete small files, modules, or tools.

## Project Documentation Framework

The main project documents are stored under `agent_docs/`:

- `agent_docs/project_overview.md`: goals, architecture, workflow, and major decisions.
- `agent_docs/project_core_tech.md`: a brief summary of special technologies or architectures of the project.
- `agent_docs/project_structure.md`: directory layout, modules, components, and ownership boundaries.
- `agent_docs/project_progress.md`: active implementation plan and cross-session execution status.
- `agent_docs/project_diary.md`: durable architecture decisions, discarded approaches, and lessons.
- `agent_docs/latest_session_work.md`: summary of previous sessions along with unfinished tasks.
- Module-specific documents, when present.

--------
`agent_docs/project_progress.md` and `agent_docs/latest_session_work.md` are two documents designed to ensure smooth and seamless deployment between multiple sessions in deployment mode. These files can only be edited in `deployment state` or when the user explicitly requests it. The main agent is responsible for updating these two documents, while subagents are not allowed to edit them.

Update documentation only with verified facts. Keep temporary reasoning, raw logs, and short-lived checkpoints out of durable project documents.

Never delete any main project document without warning the user and receiving a second explicit confirmation.

## Route Selection

There are three routes.

### Light route

Use this workflow for light tasks in the `leaf state`. Perform tasks directly without spawning subagents.

### Medium route

Use this workflow for deploying large tasks or plans in the `deployment state`. Perform implementation, verification, and documentation directly without spawning worker subagents. The deployment session's persistent `explorer` companion is the only exception and is not counted as a subagent.

Read and follow `agent_docs/workflow/medium_route.md`.

### Heavy route

Use this workflow for orchestrating subagents to deploy large tasks or plans in the `deployment state`. Reuse the deployment session's persistent `explorer` companion to absorb bounded supplementary context and return concise findings to the main agent. It is not counted as a worker subagent.

Read and follow `agent_docs/workflow/heavy_route.md`.

### Route selection rules and state interpolation

The route will be specified by the user, like: "use Light/medium/heavy route...". Apply that route throughout the entire session until it ends or until the user indicates a switch. If the user does not specify a route, select the light route as the default. Do not guess and choose a route yourself.

If the light route is specified or chosen, it means we are in the `leaf state`.
If the medium or heavy route is specified, we will proceed in the `deployment state`.

## Context Loading

- In the Light route (`leaf state`), read only the files relevant to the current task.
- On first entering the `deployment state`, immediately initialize exactly one session-long `explorer` companion. Reuse the same thread for every later bounded context investigation, including across Medium/Heavy route changes within the session. Do not spawn a new explorer for each request; replace it only when the applicable lifecycle rules require it. The explorer is a read-only second brain for the main agent and is excluded from worker/subagent counts.
- An explorer assignment defines the investigation focus, not a hard reading boundary. The explorer may follow directly related files, symbols, call sites, documentation, dependencies, and configuration when needed, while remaining read-only and avoiding unrelated repository-wide exploration.
- Load the foundational project context in one bounded read-only batch:
  1. `agent_docs/project_overview.md`
  2. `agent_docs/project_structure.md`
  3. `agent_docs/project_progress.md`
  4. `agent_docs/latest_session_work.md`
- After the batch returns, interpret overview and structure before reconciling progress and the latest-session handoff. This interpretation order does not require separate outer tool calls.
- Use the resulting status and ownership map to inspect the smallest relevant interfaces, call sites, tests, and configuration surface.
- Read only relevant module documentation. Expand source inspection only when repository evidence requires it.
- Reconstruct active tasks, dependencies, verification state, and blockers. Resolve contradictions with targeted evidence.
- Under the Heavy route, review only critical hunks and integration boundaries after delegation unless risk, missing evidence, or conflicting results require broader inspection.
- In final agent-usage statistics for a deployment session, always include the explorer's call count and label it as a `companion`, even though it is excluded from worker/subagent counts.

## Platform-specific paths

Paths in this workflow are written using `/` as a platform-neutral separator.
When running filesystem commands, use paths appropriate to the current environment:

* On Linux and macOS, use `/`.
* On Windows, use the equivalent Windows path format and `\` where required.

Do not treat the example path separator as a literal requirement. Resolve every path using the conventions of the current environment.
