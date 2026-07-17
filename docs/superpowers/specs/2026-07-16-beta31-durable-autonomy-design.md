# Beta.31 Durable Autonomy Design

## Status and scope

This design implements the Beta.31 product contract from baseline `e050f00`.
It extends the packaged acceptance foundation; it does not replace that
foundation or move product behavior into the acceptance harness.

Beta.31 is a release program composed of five dependency-ordered slices:

1. durable mission ownership, context survival, recovery, resume, and Guardian
   completion;
2. truthful model discovery, normalized metadata, and the model picker;
3. controlled browser, screenshot, vision, and frontend validation;
4. automatic Cortex memory and validated procedural skills;
5. packaged acceptance, real-model proof, focused security review, and release.

Each slice must leave `pnpm check`, relevant tests, and the production build
green before the next slice begins. The final release verdict still depends on
all slices and all required packaged acceptance scenarios.

## Investigation findings

### Mission ownership

`morrow mission` currently owns the lifecycle in the CLI process. It creates a
mission, generates and approves criteria, runs one one-shot chat task, verifies,
runs an independent review, optionally performs a bounded repair loop, and then
finalizes. The orchestrator stores mission records but no durable controller
owns the next action. Closing or restarting the CLI can therefore stop the
workflow even though individual task state is durable.

Task completion and mission completion also use different authorities. An
agent task creates a canonical answer and becomes `completed` when a provider
turn ends without tools after a small set of local checks. The mission Guardian
runs later, under CLI coordination. A final-looking response can therefore end
the worker before the mission contract is satisfied.

### Context and continuity

The execution layer already has durable segments, provider turns, checkpoints,
leases, canonical answers, and provider-continuation records. These are the
right primitives. Their terminal behavior is the problem:

- deterministic context preflight failure marks the segment and task failed;
- provider errors that exhaust the immediate fallback set mark the task failed;
- three locally classified no-progress turns interrupt the task;
- repeated tool signatures interrupt instead of invoking mission-level
  diagnosis and replanning;
- an arbitrary 64-segment ceiling interrupts unattended execution;
- the packaged foreground service calls `recoverRunningTasks`, which marks work
  interrupted, instead of the checkpoint-aware startup reconciler used by the
  standalone orchestrator.

The checkpoint snapshot contains useful fields, but derives the contract from
one prompt and does not carry the full durable mission graph, criterion states,
recovery decisions, memory/skill use, or per-operation idempotency state.

### Progress and recovery

Progress is reduced to response characters or a new tool/result fingerprint.
This cannot represent investigation, evidence gained, a hypothesis eliminated,
a changed strategy, a checkpoint, a newly identified blocker, or reduced
uncertainty. Failure categories are also narrower than the product contract and
their retry ladder is primarily an advisory mission ledger; the controller does
not consistently execute the selected recovery.

### Models

`routing/models.ts` is a hardcoded list called authoritative without source,
version, fetch time, lifecycle, availability, or confidence fields. `/api/models`
equates provider configuration with account availability. Context metadata is
re-derived through several compatibility shapes, and custom compatible routes
use fallback admission limits that can be mistaken for model facts.

Current official provider documentation already disagrees with the bundled
list. For example, OpenAI's current API catalog names GPT-5.6 Sol/Terra/Luna,
Anthropic lists Claude Fable 5, Opus 4.8, Sonnet 5, and Haiku 4.5, Google lists
current Gemini 3.x/2.5 families, and DeepSeek documents V4 Pro/Flash plus the
retirement date for legacy aliases. Runtime scraping is not acceptable; a
validated catalog and provider discovery are.

### Computer access

The repository contains a security-conscious Playwright controller with DOM
snapshots, console/page-error evidence, screenshots, downloads, cancellation,
and network guards. It is exported as a library but is not exposed to the agent
tool set or mission verifier. The mission evidence runner returns browser
verification as inconclusive. Frontend completion therefore has no automatic
rendered-result gate. Its command verifier also shells model-produced command
strings instead of using the structured command policy used by the agent.

### Memory and skills

Memory retrieval injects all enabled project/conversation entries in creation
order up to a character cap. Memory is created only through user-facing API/CLI
operations; there is no evidence-backed automatic candidate lifecycle,
relevance ranking, conflict resolution, verification, or execution-impact
record.

Installed skills can be discovered automatically, but procedural skill creation
depends on a model calling `create_skill`. The created workflow is not promoted
through candidate, isolated validation, activation, monitoring, and rollback
states. Usage counts alone do not prove success.

### Acceptance

The foundation correctly provides isolated runs, atomic state, append-only
evidence, truthful classifications, packaged invocation, containment, and
redaction. It has one fixed read-only smoke scenario. Beta.31 should generalize
the scenario contract while retaining those storage and reporting guarantees.

## Approaches considered

### 1. Enlarge the foreground CLI workflow

The CLI could loop longer, invoke more retries, and call `resume` itself. This
is the smallest textual change but cannot survive terminal loss, does not give
the orchestrator authoritative ownership, and duplicates lifecycle decisions
across clients. Rejected.

### 2. Replace missions and tasks with a new job framework

A new workflow engine could model every phase directly. It would duplicate the
existing mission ledger, task state machine, execution segments, checkpoints,
leases, approvals, and evidence. It is too broad and conflicts with the mandate
to stabilize the current vertical slice. Rejected.

### 3. Add an orchestrator-owned durable mission controller

The controller treats existing agent tasks as replaceable workers. It advances
one persisted mission operation at a time, waits on durable task/approval/tool
state, classifies results, chooses recovery or validation, and alone requests
terminal disposition. Existing task execution, segments, providers, tools,
mission criteria, and evidence remain reusable. Selected.

## Durable mission controller

### Canonical persisted records

Add a normalized runtime record keyed by mission ID and append-only operation
records. The runtime record includes:

- runtime state and transition sequence;
- validation contract version;
- current operation and requirement node;
- task graph and task/operation linkage;
- repository, branch/worktree, and permission-policy snapshot;
- active provider/model descriptor and history;
- checkpoint and continuation references;
- recovery policy, failure signatures, failed strategies, and next retry time;
- open approval IDs;
- retrieved memory IDs and selected skill versions;
- cancellation, blocker, abandonment, or completion disposition detail;
- lease owner, generation, and expiry for single-controller ownership.

Operation records have stable idempotency keys, attempt numbers, preconditions,
expected effects, verification strategy, result/evidence references, and replay
policy. They are the authority for deciding whether a side effect should run
after restart.

Large logs stay in existing artifact/output stores and are referenced by ID.

### State machine

The runtime state machine is separate from the existing public mission grade:

`created -> orienting -> planning -> executing -> validating -> recovering ->
replanning`, with explicit `waiting_for_tool` and `waiting_for_approval` wait
states. Terminal states are `blocked`, `completed`, `cancelled`, `abandoned`,
and `superseded`.

Every transition persists timestamp, previous/next state, cause, operation,
task, actor, context segment, and evidence/error references in one transaction.
Only the controller may move to a terminal runtime state. Provider text, task
status, and client requests are inputs, never completion authority.

### Dispatch and restart

The controller runs inside the orchestrator and uses a fenced lease. Creating or
approving an autonomous mission schedules the controller; the CLI observes and
streams durable events. Startup reconciliation first claims abandoned mission
controller leases, then checkpoint-aware task leases, then resumes the next
incomplete operation. The packaged foreground service uses the same reconciler.

Controller ticks are event-driven and bounded: one durable decision or dispatch
per tick, followed by rescheduling when the awaited state changes. This avoids a
single giant call stack while supporting hours-long missions.

### Completion Guardian

Each authoritative criterion has a required evidence class, validator, state,
evidence references, timestamp, confidence, and any override detail. Before
completion the Guardian verifies:

- all authoritative requirement nodes are verified or explicitly waived;
- all dispatched operations are terminal and no approval is open;
- required tests/build/lint/typecheck/runtime/browser evidence passed;
- the final diff is reviewed and protected/unrelated paths are intact;
- no unresolved framework, tool, provider, or verification failure remains;
- the canonical provider answer exists but is not treated as proof;
- every acceptance criterion has direct evidence.

A provider final answer merely returns control to the controller. If evidence is
missing, the controller dispatches validation or repair. `completed` is written
transactionally with the final Guardian decision and evidence snapshot.

## Context survival and progress

### Budget and rollover

One resolved `ModelDescriptor` provides context window, maximum output, reserves,
usable input, current segment usage, rollover threshold, and emergency threshold.
Unknown public capacity remains unknown; a separately labelled conservative
admission limit may still protect execution.

Before rollover, the worker finishes or interrupts the atomic operation, saves
all durable turns/events, records Git/workspace and operation state, creates a
structured continuation package, checkpoints, rolls the segment, and continues
automatically. The continuation package is the mission/operation projection
required by the product contract, with artifact references for large outputs.
A test-only threshold exercises the production rollover path.

There is no arbitrary mission duration or segment-count completion condition.
Usage controls act through explicit policy, cost, approval, cancellation, or an
evidence-backed abandoned disposition after adaptive recovery is exhausted.

### Progress model

Progress becomes an append-only observation with a category and before/after
fingerprint. Categories include new evidence, uncertainty reduced, hypothesis
eliminated, strategy changed, subtask completed, checkpoint created, criterion
validated, blocker refined, recovery succeeded, tool effect, and repository
effect.

Repeated action detection remains an input. Before abandonment the controller
must inspect evidence deltas, context pressure, attempted strategies, and the
current operation, then request a revised strategy, replan, try a distinct safe
strategy, and perform focused diagnosis. Exhaustion reports the operation,
attempts, evidence gained, failure signature, eliminated/remaining strategies,
retry condition, and exact external dependency.

### Failure recovery

Expand failure types to the contract's provider, authentication, model,
protocol, tool, command, process, context, permission, dependency, environment,
validation, Git, completion, external, and internal categories. Recovery rules
produce an executable next operation, not only a label. Idempotency and strategy
fingerprints prevent blind repetition and infinite loops.

## Model truth

### Descriptor and sources

Replace `ModelInfo` as an operational authority with one versioned
`ModelDescriptor` containing provider/auth mode, provider and canonical IDs,
aliases, display/family/generation/lifecycle/availability, context and output
limits, reserves, reasoning, capabilities, pricing, source/version/fetch time,
and per-field confidence.

Resolution precedence is provider-reported account metadata, validated remote
Morrow catalog, bundled validated catalog, explicit custom-provider metadata,
then unknown. Values are merged per field with provenance; a lower-priority
source cannot overwrite a higher-priority known value. Custom routes never
inherit official-provider facts from a matching name.

The remote catalog is static data with a versioned strict schema, size and time
limits, conditional refresh, atomic last-known-good cache, and bundled offline
fallback. The runtime never scrapes documentation and never executes catalog
content. Bundled facts record the official source URLs and verification date.

Provider adapters may discover model IDs and metadata through official APIs for
the configured authentication mode. API key and Codex OAuth availability are
separate. A configured provider is not synonymous with a model available to the
account.

### Surfaces and picker

All routes, context admission, `/model`, `/context`, header/footer, diagnostics,
checkpoint, resume, and reports persist or reference the same descriptor ID and
version. Compatibility fields are projections from that object.

The picker defaults to configured authentication modes and actually available,
current/recommended canonical models. It deduplicates aliases, shows concise
provider/auth/context state, supports search and narrow terminals, and hides
legacy/custom/unavailable entries behind an advanced toggle. Unsupported
reasoning choices are never selectable.

## Computer, browser, and vision

Integrate the existing Playwright controller through durable mission-scoped
browser sessions and explicit tools for navigation, DOM snapshot, console and
page errors, interaction, viewport, screenshot, and close. Local development
server access is allowed only for the mission's explicitly approved loopback
origin; external browsing remains separately permissioned and domain-scoped.
Downloads and screenshots use mission-contained artifact directories.

Screenshot evidence includes viewport, route, content hash, artifact reference,
and browser/console state. A vision-capable descriptor is required before image
input is sent to a provider. If the selected route lacks vision, the controller
must choose an allowed capable route or record the criterion as blocked; it
cannot claim visual inspection.

Frontend mission classification automatically expands the validation contract
to server health, representative routes, DOM, console, desktop/tablet/mobile
screenshots, vision review, required interactions, repair, and final retest.

Mission verification commands use structured executable/argument arrays and the
same containment and permission policy as agent commands. Shell strings from a
model are not executed.

## Automatic memory

Add versioned memory candidates with scope/type/content, evidence, confidence,
sensitivity, timestamps, usage and contribution counters, staleness, conflict
and supersession links, and lifecycle state. Deterministic extractors create
candidates from verified repository facts, successful commands, accepted
decisions, repeated failures, user instructions, and Guardian outcomes.

Promotion requires corroborating durable evidence and sensitivity screening.
Secrets, private messages, raw logs, and unsupported model claims are rejected.
Repository fingerprints drive scoped staleness.

At mission start and major phase boundaries, relevance scoring retrieves current
memory by scope, type, lexical/structural match, confidence, and prior
contribution. Retrieval IDs and the resulting plan/operation changes are
persisted so acceptance can prove behavioral effect, not mere storage.

## Automatic procedural skills

Record normalized successful workflow observations from operation/evidence
sequences. Repetition can create a candidate skill, but not an active executable
skill. Candidate records include version, triggers, scope, steps, permissions,
validation contract, provenance, success/failure counts, confidence, and
rollback history.

Promotion runs the candidate in an isolated deterministic fixture or shadow
mode with no broader permissions than the observations. The result and security
checks are durable evidence. Only validated active versions enter automatic
selection. Later outcomes update monitoring; regressions disable or roll back
the version. Generated instructions remain data interpreted by the bounded skill
runtime, not self-modifying application code.

## Packaged acceptance

Generalize the foundation scenario as a registry of versioned scenarios sharing
the existing run root, atomic state, append-only evidence, redaction, truthful
classification, source fingerprint, and report writers.

Deterministic scenarios cover write-capable repair, controlled rollover,
provider/tool/command failures, abrupt process restart, premature completion,
legitimate investigation, browser/vision frontend work, automatic memory,
automatic skills, and model truth. Fault injection occurs at provider/tool/
process boundaries, not by weakening production code.

After deterministic packaged scenarios pass, one configured real model runs one
write-capable autonomous packaged mission. A legitimate extended workload proves
continued productive operation, checkpoint cadence, restart/rollover/recovery,
zero ordinary user continuation, and evidence-backed completion. A broad
provider matrix is not required.

## Security and privacy

Focused review and regression tests cover:

- controller and task lease fencing;
- operation idempotency and ambiguous tool effects;
- command/path containment and cleanup;
- remote catalog schema, origin, cache replacement, and downgrade behavior;
- browser DNS rebinding, local-origin scope, downloads, uploads, screenshots,
  prompt injection, and profile isolation;
- memory sensitivity, poisoning, conflict, and cross-scope leakage;
- skill provenance, promotion permissions, executable content, and rollback;
- approval-policy/display agreement;
- credential and private-path redaction in events, checkpoints, and reports.

No telemetry, hosted dependency, or silent external inference is introduced.
Publication, push, deployment, credential mutation, destructive operations, and
unrelated file access remain explicit boundaries.

## Rollback and compatibility

Database migrations are additive. Existing tasks and missions lazily receive
runtime records when resumed; old clients continue to read the existing mission
grade and task status projections. New descriptor and controller fields have
safe unknown/default projections.

Controller dispatch can be disabled by configuration for emergency rollback,
leaving durable state inspectable and resumable. Remote catalog failure falls
back to the last-known-good or bundled catalog. Browser sessions are disposable
and mission-scoped. Memory candidates and candidate skills can be retired or
disabled without deleting evidence history.

Release rollback retains the prior Beta.30 artifacts and public metadata. A
Beta.31 rollback never rewrites user workspaces or deletes mission evidence.

## Acceptance of this design

The pasted Beta.31 brief explicitly directs implementation to continue without
approval pauses and supplies the required architecture, constraints, phases,
and release gates. This document resolves implementation placement and source-
of-truth decisions within that approved envelope; it does not add unrelated
scope.
