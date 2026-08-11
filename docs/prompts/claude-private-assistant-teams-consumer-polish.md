# Claude handoff prompt: private assistant, agent teams, and consumer polish

Copy the prompt below into Claude Code from the Morrow repository.

---

## Prompt

You are continuing development of Morrow, a local-first personal AI agent.
Work in the existing repository only. Do not treat this as a greenfield app and
do not reframe Morrow as a generic SaaS dashboard, operating system, enterprise
control plane, or hosted AI product.

### Mission

Design and then implement the next coherent Morrow product slice across three
connected directions:

1. A genuinely private personal assistant.
2. Persistent named agent teams with safe delegation.
3. Consumer-grade product polish around the existing chat and command workspace.

The goal is not to add disconnected screens. The goal is a trustworthy product
loop:

> A person tells Morrow something once, Morrow remembers it only within an
> explicit boundary, delegates work to named specialists when useful, shows what
> is happening and what data leaves the machine, and returns a clear result a
> normal person can understand.

Build one reliable vertical slice first, then extend it only when the contracts,
permissions, persistence, and evidence are sound.

### Repository and baseline

Before making any change:

1. Confirm the current working directory and run `git status --short --branch`.
2. Read `README.md`, `AGENTS.md`, `SECURITY.md`, `docs/architecture.md`,
   `docs/privacy-model.md`, `docs/roadmap.md`, `docs/hermes-parity.md`,
   `docs/benchmark-plan.md`, and the relevant `agent_docs/` files.
3. Inspect the current interfaces, repositories, contracts, event stream,
   orchestrator execution path, and existing web chat features.
4. Do not reset, clean, checkout, discard, overwrite, or auto-format unrelated
   work. Preserve every pre-existing dirty or untracked file.

The relevant committed baselines are:

- `c1b35d6 feat(web): polish command workspace and reasoning controls`
  - This is the current web UI foundation. It includes the chat-first shell,
    command workspace, model picker, normalized reasoning controls, reasoning
    disclosure, activity presentation, theme tokens, and responsive styling.
  - Extend this visual language. Do not replace it with a new UI system or
    redesign the product from scratch.
- `462b404 perf(harness): measure and reduce execution overhead`
  - This contains the deterministic efficiency benchmark, append-only evidence,
    the efficiency report, provider-attempt accounting, semantic observation
    deduplication, applied-write projection repair, bounded retry accounting,
    and DeepSeek reasoning-wire normalization.
  - Preserve its invariants and use its benchmark patterns for new behavior.

The repository may still contain unrelated uncommitted files from the owner,
including CLI changes, screenshots, helper scripts, registry tests, and design
plans. Do not stage or modify those unless the owner explicitly asks for them.

### Product principles that are hard requirements

- Local-first and provider-neutral. Local models, cloud models, and compatible
  endpoints remain user choices.
- No hidden telemetry, analytics, hosted inference, or silent external
  integrations.
- Provider credentials stay server-side/local and never enter the web client,
  prompts, events, screenshots, fixtures, or committed files.
- The model cannot grant itself permissions, expand a child agent's authority,
  read another scope's memory, approve its own risky action, or bypass a parent
  budget.
- Every meaningful task transition is persisted before the UI presents it as
  complete.
- Tool results and web content are untrusted input. Prompt injection must not
  change permissions or routing.
- Completion is proof-driven. Never display verified success when the required
  artifact, test, process cleanup, or evidence is missing.
- Default experiences stay simple. Advanced controls appear progressively.
- Actions that change files, memory, permissions, schedules, or external data
  need an approval boundary and a reversible history where appropriate.
- Do not claim encryption, privacy, cost savings, autonomy, or provider support
  unless the implementation and tests prove the claim.
- Prefer focused modules, existing repositories, existing contracts, SQLite,
  and existing event infrastructure. Do not add a framework or dependency for
  convenience.

### Required design gate

Do not start implementation immediately. First produce a bounded design and
implementation plan for the first vertical slice. The first response must
include:

- current architecture findings;
- the exact scope for the first slice;
- what is explicitly deferred;
- proposed contracts and persistence boundaries;
- permission and privacy decisions;
- UI surfaces and user journeys;
- the test matrix;
- risks and rollback strategy;
- a file-level implementation plan.

Wait for approval before writing feature code. If the scope is too broad, split
it into separately reviewable phases rather than attempting all three themes at
once.

## First vertical slice to design

The recommended first slice is:

1. A local personal assistant profile with explicit, inspectable memory.
2. One team containing two named specialists: `Researcher` and `Verifier`.
3. A deterministic local task that delegates from the parent assistant to the
   team, produces a bounded artifact, hands it back, and shows the complete
   evidence trail in the existing web workspace.
4. A polished onboarding and result state for that flow.

Use mock/local providers and controlled fixtures first. Do not require a live
provider, network access, messaging integration, voice service, or hosted
account to prove the slice.

### A. Private personal assistant

Design a personal assistant layer that is useful without becoming an opaque
surveillance system.

#### Assistant profile

Support a user-owned profile with:

- display name and optional assistant name;
- communication preferences such as concise/detailed and technical/nontechnical;
- explicitly chosen timezone and locale;
- preferred provider/model route and reasoning preference;
- default privacy mode;
- default approval posture;
- optional goals/routines, each with an explicit enabled/disabled state.

Do not silently infer sensitive profile facts. User-authored profile facts must
be visibly distinguishable from model-inferred suggestions. Any inferred
candidate must be proposed for approval before it becomes durable memory.

#### Scoped memory vault

Design memory as typed, scoped records rather than one undifferentiated prompt
blob. At minimum, support these scopes:

- `personal`: user-wide preferences and facts;
- `project`: project-specific context;
- `agent`: specialist-specific working knowledge;
- `team`: explicitly shared team knowledge;
- `task`: temporary task context;
- `ephemeral`: request-only context that must not persist.

Each memory record should have a clear repository-backed shape, adapted to
existing Morrow contracts, with fields equivalent to:

- stable ID and scope type/owner;
- content or protected payload reference;
- memory kind/category;
- source type and source event/task/message;
- user-authored versus model-suggested provenance;
- confidence or certainty state, without pretending confidence is truth;
- created/updated/last-used timestamps;
- optional expiration/retention policy;
- sensitivity classification;
- provider-sharing policy;
- active/archived/deleted state;
- content hash or revision for audit and deduplication.

Memory behavior must include:

- explicit save, approve, edit, forget, archive, and restore operations;
- source inspection: why this memory exists and where it came from;
- retrieval preview before a provider call when the memory is sensitive;
- scope-filtered retrieval with deterministic top-k limits;
- duplicate and near-duplicate suppression;
- no cross-project or cross-agent leakage;
- no automatic promotion from task or ephemeral memory into personal memory;
- a user-visible record of when memory influenced a task;
- deletion that removes it from future retrieval and records the deletion event;
- export/import that is local, explicit, redacted where appropriate, and
  versioned.

If at-rest encryption is introduced, put it behind a replaceable storage
boundary, use user-controlled or OS-protected key material, test locked/unlocked
behavior, and never print plaintext memory or keys. If encryption cannot be
implemented safely in the first slice, implement the scope and access boundary
honestly and document encryption as a separate deferred milestone.

#### Privacy modes

Provide understandable request-level privacy modes, for example:

- `Local only`: no external provider request; use a local provider or fail closed
  with an actionable explanation;
- `Private`: allow the selected provider only the explicitly approved context;
- `Project`: allow project-scoped context and approved provider sharing;
- `Web enabled`: allow browser/web tools only after the user understands the
  external-data boundary.

Before a request leaves the machine, show a compact data-sharing preview:

- provider and model;
- context categories being sent;
- memory records included, by label/source rather than raw secret content;
- tools available;
- estimated input/output budget if available;
- whether browser or external network data is involved.

Do not add telemetry to implement this preview. Use existing local event and
provider-projection infrastructure.

#### Personal routines

Treat routines as a later part of the same assistant model, not a second
scheduler. For the first slice, it is enough to model a routine definition and
show a disabled or local deterministic preview. A production routine must later
have:

- explicit schedule and timezone;
- frozen provider, model, memory, tool, and approval policy;
- dry-run mode;
- cancellation;
- retry limits;
- durable run history;
- no permission expansion while unattended.

Do not implement external messaging, email, or unattended destructive actions in
the first slice.

## B. Persistent named agent teams

Agent teams should be durable, inspectable work units—not invisible subagents
that multiply model calls.

### Team and agent definitions

Reuse existing Morrow domain boundaries where possible. If new contracts are
required, design them explicitly. The conceptual records are:

#### Team

- ID, name, purpose, owner/project scope;
- lifecycle state: draft, active, paused, archived;
- member agent IDs;
- shared-memory policy;
- default budget and concurrency limits;
- default approval policy;
- artifact/workspace policy;
- created/updated timestamps and revision.

#### Agent

- ID, team ID, display name, role, mission;
- system instruction or skill reference;
- provider/model route;
- reasoning setting;
- tool profile;
- memory scopes allowed for read and write;
- approval requirements;
- max provider calls, token budget, wall-clock budget, and child-task limit;
- status and last activity;
- provenance of who created or changed the definition.

The user must be able to inspect the effective policy before a team runs. A
child agent receives the intersection of parent authority, team policy, and its
own policy. It can never broaden that intersection.

### Delegation and handoff

A parent task should be able to create a child delegation with:

- objective and acceptance criteria;
- exact context snapshot or references;
- assigned agent and team;
- allowed tools and memory scopes;
- provider/model route;
- call/token/time budget;
- approval requirements;
- cancellation and deadline;
- parent task and correlation ID.

Delegation should be visible before execution when the action is material. The
user can approve, edit, reject, or run a dry run. The child receives only the
approved input projection, not the parent's entire conversation history.

A handoff should contain:

- concise result summary;
- acceptance criteria status;
- artifact IDs/paths and content hashes;
- verification evidence;
- unresolved risks or questions;
- source agent and target agent;
- durable timestamp and task IDs.

Do not treat a model's prose saying "done" as a handoff. The parent must inspect
durable child status, artifacts, and required verification.

### Team execution rules

- Start with sequential two-agent execution; do not introduce concurrency until
  ownership and cancellation are proven.
- Use a single durable parent/child task graph, not disconnected chat sessions.
- Persist events before streaming them to the UI.
- Support pause, cancel, resume, and restart recovery.
- Bound retries by failure class; never retry permission, authentication,
  malformed-contract, or destructive-action failures blindly.
- Deduplicate equivalent delegations and observations.
- Preserve exact task identity and turn keys across restart/rollover.
- Keep child context compact and lossless; do not forward poisoned assistant or
  tool history.
- Record model calls, tokens, tool calls, failures, fallback routes,
  interventions, context growth, and estimated cost where available.
- Make parent cancellation propagate to children and leave an inspectable final
  state.

### Team presets

Offer a small number of opinionated presets rather than a blank configuration
matrix. The first useful preset is:

- `Research and verify`
  - Researcher: read/search/web research, no writes, bounded sources;
  - Verifier: inspect researcher output, run safe checks, write only approved
    artifacts, no external sharing by default.

Possible later presets are `Build and test`, `Plan and execute`, and
`Personal research`. Do not add all presets before the first one is reliable.

## C. Consumer-grade polish

Extend the UI from `c1b35d6`; preserve its command workspace, reasoning
disclosure, model controls, typography, tokens, and responsive behavior.

### Onboarding

Create a calm first-run path:

1. Choose or create a local project.
2. Choose a privacy mode.
3. Configure or select a provider/model, with local-only status made explicit.
4. Meet the assistant profile and memory controls.
5. Optionally create the `Research and verify` team.
6. Run a safe deterministic sample task.

The user should understand what Morrow can access, what leaves the machine, and
what requires approval before sending a real request. Do not force users through
advanced configuration before the first useful task.

### Navigation and information architecture

Use the existing shell and progressive disclosure. Add the smallest coherent
surface for:

- Assistant/home: current profile, recent tasks, suggested next action;
- Teams: team list, status, members, effective policies, create/edit/archive;
- Memory: scoped records, source, approval state, search, edit, forget;
- Activity: parent/child task timeline, model/tool/privacy/approval evidence;
- Settings: provider, privacy, reasoning, defaults, export/delete controls.

Avoid a dashboard full of metrics. Every surface should help the user decide
what to do next.

### Task and team activity

The activity view should expose, progressively:

- plain-language current state;
- parent and child task relationship;
- agent and model;
- reasoning disclosure where supported;
- tool calls and targets;
- files/artifacts changed;
- approvals and permissions;
- memory records used;
- external data-sharing status;
- cost/token/context details when available;
- verification evidence;
- recovery action when blocked.

Technical detail must be available without making the default view intimidating.
Zero evidence must not render as successful evidence.

### Result states and errors

Use honest result states:

- `Completed`: acceptance criteria and required evidence passed;
- `Completed with notes`: result delivered with non-blocking caveats;
- `Needs attention`: work exists but a required verification or approval remains;
- `Blocked`: permission, provider, context, or missing-input boundary;
- `Cancelled`: user or parent task cancelled it;
- `Failed`: execution ended without satisfying the contract.

Every error should say:

- what happened;
- whether work was changed;
- what Morrow retained;
- the safest next action;
- whether retrying will repeat the same failure.

Do not use generic "something went wrong" states and do not hide provider or
permission boundaries behind optimistic copy.

### Accessibility and responsive behavior

Preserve and extend the existing standards:

- keyboard navigation and visible focus;
- semantic headings, labels, landmarks, and live regions;
- reduced-motion support;
- readable contrast in both themes;
- responsive layouts for desktop, tablet, and mobile;
- usable empty, loading, error, offline, and long-content states;
- no critical interaction that depends only on color, hover, or a screenshot.

## Architecture and data flow

Respect these boundaries:

- `apps/web` owns presentation and user interaction.
- `services/orchestrator` owns tasks, plans, agents, teams, checkpoints,
  retries, schedules, budgets, approvals, and event coordination.
- `packages/contracts` is the canonical schema boundary.
- SQLite remains the early default behind repositories.
- Provider credentials never belong in the browser.
- Existing event streams and durable task records are authoritative.
- Memory retrieval must produce a provider projection with scope and provenance;
  it must not concatenate an unbounded private database into prompts.
- Child tasks must be reconstructible from durable IDs and turn keys.
- UI state must be derived from events/API records rather than inventing status.

For every new boundary, define:

- input/output contract;
- owner module;
- persistence and migration behavior;
- authorization rule;
- failure/recovery behavior;
- redaction/privacy behavior;
- deterministic test seam.

If a major invariant changes, add or update an architecture decision record.

## Efficiency requirements

Do not make the assistant/team layer expensive by default. Measure and preserve:

- provider calls per parent and child task;
- tool calls and duplicate observations;
- input, cached, output, and reasoning tokens when available;
- context size and growth;
- memory tokens included per request;
- tool-schema overhead;
- retries, fallbacks, and recovery attempts;
- time to first provider output and task completion;
- task success/partial/failure;
- file-write and artifact reliability.

Use memory retrieval with scope, relevance, recency, and a hard token budget.
Cache immutable team definitions and compact handoff summaries. Expose only the
tool profile required by the agent's policy. Never duplicate a child task or
repeat a successful read/write because of a replayed event. Reuse the existing
deterministic benchmark and append-only evidence conventions from `462b404`.

## Security and privacy acceptance criteria

The implementation is not acceptable unless it proves:

1. A personal memory cannot be retrieved by another project when scopes differ.
2. An agent cannot read or write a scope absent from its policy.
3. A child agent cannot expand its tools, model route, budget, or approval power.
4. A parent cancellation stops or parks child work safely.
5. Restart/resume does not duplicate a delegation or replay a successful write.
6. Prompt injection in a memory, file, or web result cannot grant authority.
7. Local-only mode produces zero external requests in deterministic tests.
8. Provider-sharing previews omit raw secrets and explain the boundary.
9. Delete/forget removes memory from future retrieval and leaves safe audit
   evidence without retaining sensitive plaintext.
10. Export/import does not silently widen scope or permissions.

## Strict TDD and verification workflow

For every behavior change:

1. Add a focused failing test first and show the RED failure.
2. Implement the smallest coherent fix.
3. Show the GREEN result.
4. Add regression and failure-path coverage.
5. Run the narrowest useful checks, then the full suite before completion.

At minimum, add deterministic tests for:

- memory scopes and leakage prevention;
- memory approval/edit/forget/retrieval provenance;
- local-only no-network enforcement;
- privacy preview redaction;
- team/agent policy inheritance and refusal;
- delegation, handoff, duplicate suppression, cancellation, and restart;
- parent/child completion contracts;
- provider failure, context pressure, and bounded recovery;
- UI onboarding, empty/loading/error/result states;
- keyboard and accessible semantic interaction;
- responsive layouts where the existing test strategy supports it.

Run, as applicable:

```text
pnpm test
pnpm check
pnpm build
git diff --check
```

Use local fixtures and mock providers by default. Do not inspect credentials or
run a live provider without an explicit preflight estimate and authorization.
Do not claim Hermes/Pi superiority without equivalent measured runs.

## Scope guardrails

Defer these unless the first slice proves the core contracts:

- voice and wake-word behavior;
- messaging/email integrations;
- remote access and multi-user accounts;
- marketplace/plugin discovery;
- hosted billing/subscriptions;
- autonomous financial, account, deployment, or destructive actions;
- broad provider proliferation;
- a new frontend framework or state-management rewrite;
- a second parallel task/runtime architecture;
- generic analytics or telemetry.

## Required deliverables

Before implementation approval, provide:

- a design/spec with explicit scope and deferred work;
- a component and contract map;
- persistence/migration plan;
- privacy and permission matrix;
- user journeys and failure states;
- test plan with RED/GREEN checkpoints;
- rollback plan.

After implementation, provide:

- exact changed files;
- commands and test counts;
- deterministic benchmark/evidence results;
- screenshots or rendered semantic browser evidence for UI changes when
  available;
- known limitations and unverified claims;
- security/privacy impact;
- rollback instructions;
- focused Conventional Commit(s).

Do not push, merge, or open a pull request. Leave unrelated work untouched.

## Final quality bar

The result should feel like a calm, private, understandable assistant that can
remember intentionally, delegate safely, and explain itself clearly. It should
be more trustworthy because every boundary is visible—not because it makes
larger claims about autonomy.

---
