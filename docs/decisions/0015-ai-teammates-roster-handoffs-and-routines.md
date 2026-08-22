# ADR-0015: AI teammates, guarded handoffs, and truthful routines

**Status:** Accepted (2026-08-20)

**Scope:** Local-first teammate vertical slice, including durable routine
scheduling, ownership-aware memory, group conversations, bounded context
references, and notification delivery. This extends
[ADR-0012](0012-assistant-memory-and-teams.md); it does not replace the
existing team/delegation policy model.

## Context

Morrow's chat surface is becoming a roster of named teammates. The product
needs to show who a thread belongs to, let a user or model ask another
teammate for bounded help, keep the resulting work inspectable, and let a user
teach a routine by demonstration. These surfaces cross execution, approvals,
memory, model-provider, and browser privacy boundaries. A presentation layer
must not become a second authority model or turn private task data into a
polling payload.

## Decision

### Roster identity is separate from execution policy

- A durable `agents` row is the teammate identity: name, role, standing
  instructions, and optional provider/model override. A conversation has one
  durable `conversations.agent_id` binding for its entire life. A turn that
  names a different agent is refused; an unassigned conversation remains the
  built-in default teammate.
- `buildTeammateIdentity`/`buildTeammateBrief` describes who the run is and
  what job the user assigned. It is separate from `buildAgentExecutionPolicy`,
  which derives tools, memory scopes, approval posture, and budgets from
  durable agent/delegation rows. Identity text cannot widen policy. Roster
  status and last-line summaries are redacted projections derived from live
  tasks and approvals; model output cannot set them.

### User and model handoffs use the same durable task relation

- Both UI handoffs and model-authored `ask_teammate` children are represented
  by `tasks.parent_task_id` plus `tasks.agent_id`. They get a fresh child
  conversation containing the bounded objective, not the parent's full
  transcript, and execute under the child's own provider, memory, tools, and
  budget. Team agents are refused by this simple path and must use the team
  delegation API, where team policy is intersected correctly.
- `ask_teammate` accepts only `agentId` and `objective`. The server resolves an
  enabled, same-project, standalone target and rejects unknown, disabled,
  cross-project, self, and team targets. Both the built-in Morrow assistant and
  standalone named teammates can author this handoff. Morrow has no synthetic
  `agents` row, so its requests always require a fresh `allow_once` approval,
  even when the parent requested auto approval. Named callers may instead use
  an explicit, bounded standing teammate trust grant. Approval binds the target
  profile fingerprint (including policy-relevant fields) and an objective hash;
  drift requires fresh approval. A named parent's `maxChildTasks` ceiling is
  checked before creating a child.
- The pair `(parentTaskId, toolCallId)` is the model handoff idempotency key.
  An in-process registry suppresses races and the durable task idempotency
  record suppresses replay after restart. Only successful spawns are cached;
  failed attempts remain retryable. The child never inherits the parent's
  policy or gains `ask_teammate` merely because it was asked from a capable
  thread.

### Evidence is an on-demand, privacy-bounded handle

Activity rows expose a compact summary, a redacted target, and an
`evidenceRef`; they do not carry raw arguments, tool output, provider text, or
private reasoning. The scoped evidence route resolves one tool call only,
returns a bounded/redacted result, excludes arguments except the safe target
field, sets `cache-control: no-store`, and returns 404 for a task or call from
another conversation. Model-authored handoff projections are stricter:
status, teammate identity, and `evidenceRef` only; objective, child answer,
child conversation id, and tool count are withheld from the polled parent
projection. User-started handoffs may show redacted objective/result text and
link to the child's separate thread.

### Memory UI states the ownership model truthfully

The teammate editor exposes read/write scope policy progressively. `agent` and
`team` memory records are project-local. The memory row has no per-teammate
owner, so the inspection panel labels records by scope and provenance and
explicitly says it cannot show “what this teammate learned”; another permitted
teammate may use the same records. Transcripts are not presented as learned
memory. The only cross-project exception remains the existing `user_global`
scope documented in ADR-0012.

### Routines are recorded evidence, not replay scripts

Recording is explicit and opt-in, one open span per conversation (enforced by
a database unique index). A proposal is projected from the observed completed
activity in that span; failed steps are omitted. Saving is a separate user
action and stores the objective, observed steps, teammate id, and source
conversation/recording provenance. Editing changes only the definition; the
original provenance and run history remain intact. Running creates a fresh
thread/task for the recorded teammate and re-prompts it with the objective and
steps as context, explicitly telling it to re-check the current workspace.
Captured commands and writes are never blindly replayed.

The web experience is teammate-first and responsive: the roster rail uses
avatars, names, compact last-line/status rows, and a selected teammate's
thread; handoffs and evidence are expandable rows; recording and routine
editing are available from chat/Skills. Geometry is preserved across narrow
and wide layouts while the visual system remains Morrow's own and uses local
system fonts.

### Scheduled routines are durable occurrences, not timers

Migrations 54 and 56 extend the existing schedule table without changing the
legacy `inspect_workspace` path. A routine schedule records its routine and
teammate binding, while dispatch re-checks the current routine, project,
teammate, team membership, enabled state, and policy. Each occurrence gets a
`schedule_runs` row with a unique `(schedule_id, occurrence_key)` idempotency
boundary. The run ledger retains scoped history even when a schedule is
deleted, records coalescing and task linkage, and uses recovery-owner,
expiry, and attempt fields to fence restart replay. Routine dispatch always
creates a fresh task with current approvals; it never replays captured tool
calls.

Migrations 60 and 61 add per-schedule notification preferences, adapter
selection, a durable `schedule_notification_outbox`, and an observed-event
marker. Enqueueing is deduplicated by `(schedule_run_id, adapter_id, event)`;
delivery is leased, retried, and redacted. Adapter delivery is an optional
side effect: run truth is preserved when an adapter is unavailable or rejects
the message, and an external adapter may receive a retry rather than a
cloud-level exactly-once guarantee.

### Ownership, live revocation, and MCP cancellation

Migration 55 derives private memory ownership from the durable execution actor:
`agent` rows carry `owner_agent_id`, `team` rows carry `owner_team_id`, and
database triggers reject forged/mismatched ownership. Ambiguous legacy private
rows are disabled but remain visible for inspection/deletion. Disabling or
deleting an agent, deactivating a team, or removing a member quarantines its
private memory and rejects affected in-flight delegations; it never silently
reassigns knowledge. Migration 57 preserves `user_global` memory when its
source project is deleted while deleting other project-local rows. The
provenance project id remains a fact about origin, not a retrieval boundary.

During execution, the orchestrator re-checks the assigned agent, project,
team, membership, and delegation. A revocation aborts the combined execution
signal and settles the task as cancelled; it cannot wake a pending approval or
fall through to a different provider. Browser, command, provider, and MCP
calls receive that signal. MCP request cancellation removes the pending JSON-
RPC request; task teardown closes pooled clients and transports. MCP
trust/config checks gate discovery and new connections, while an already
pooled client is not retroactively invalidated by a trust-row change. Those
trust changes are not treated as permission to continue an already revoked
task.

### Group threads use snapshots and bounded handles

Migration 58 adds `conversation.mode`, an immutable conductor, ordered
participant snapshots with profile fingerprints, and removed-participant
tombstones. Team agents remain delegation-only and cannot become a group
conductor or ordinary participant. A context reference is a handle to one
source-task artifact or evidence row, not copied transcript, provider output,
or private reasoning; the child keeps an independent conversation, provider,
memory, tool, approval, and budget policy. Migration 59 adds the explicit
per-task ownership edge for deduplicated artifacts so later producers can
authorize their own handles without changing the canonical blob's first-owner
compatibility field.

### Intentional local-first equivalence boundary

This work targets equivalent user-observable contracts—persistent teammates,
bounded collaboration, scheduled recovery, scoped memory, and inspectable
notifications—inside Morrow's local SQLite/orchestrator authority. It does not
copy or infer a proprietary hosted product's internal implementation. A
configured cloud model or message adapter may be used only by explicit user
choice; control state, approvals, history, and policy remain local. A hosted
cloud computer, cloud team synchronization, and a remote shared control plane
are intentionally out of scope.

## Security and privacy impact

The local orchestrator remains the authority for project ownership, identity,
policy, approvals, task linkage, schedule claims, and notification history.
Cross-project and policy-mismatch checks fail closed. Children and scheduled
runs receive only bounded objectives/handles and execute with independent
durable policy. One-shot approval, profile binding, child limits, occurrence
idempotency, recovery leases, secret redaction, scoped 404s, ownership
triggers, and on-demand evidence reduce authority widening, replay, leakage,
and duplicate execution risk. Notification text is generic and redacted; the
outbox contains no provider transcript, raw tool arguments, or private
reasoning. The residual local-process authentication boundary remains: remote
or multi-user exposure needs a separate authentication design.

Scheduled/recurring routine execution is now supported locally, but this slice
makes no claim of cloud team synchronization or always-on hosted teammates. A
routine run is still an explicit fresh task with current policy. Provider or
adapter data leaves the machine only when the user has configured and used that
external service, consistent with [the privacy model](../privacy-model.md).

The built-in Morrow assistant can initiate a teammate child but gains no
teammate identity, private memory owner, target policy, or standing trust from
doing so. Its request always stops at the one-shot approval boundary. The child
receives only the approved objective and then independently resolves its own
provider and tool policy; a browser objective therefore enables controlled
browser tools only when that target profile permits them.

## Failure behavior

Invalid handoff targets, thread-agent mismatches, team targets on the simple
path, exhausted child budgets, profile/objective drift, and duplicate-key
conflicts return explicit 4xx errors without starting another child. A failed
spawn records a generic redacted tool failure rather than provider output. An
open recording cannot be opened twice and a stopped recording cannot be stopped
again. Evidence outside its task/conversation is a 404. A missing or disabled
routine teammate, team target, or changed routine binding blocks a scheduled
run without starting a task. A claimed occurrence with no task is reconciled
through its idempotency key; an interrupted task is replayed only after a
recovery lease is acquired, while pending approvals remain parked. Failed or
unavailable notification adapters leave a pending outbox row for retry and do
not change run status. Revoked agent/team authority cancels active work and
cannot revive it through approval resolution; MCP calls receive the same abort.
Routine edits reject empty changes and cross-project ownership. Group invites,
conductor removal, cross-project handles, unowned artifacts, and duplicate
context refs fail closed; failed deferred children clean up their task,
ledger, and empty conversation shell. Ambiguous legacy private memory remains
disabled and inspectable rather than being guessed.

## Rollback

The implementation is forward-only and migration-safe: migrations 52–61 bind
conversation identity, routines, scheduled occurrences/recovery, memory
ownership/global retention, group/context handles, artifact ownership, and
notifications. Migration 57 performs a data-preserving memory-table rebuild;
it does not discard rows. Roll back behavior by stopping the scheduler,
disabling notification adapters, and reverting feature code/routes while
retaining the new columns/tables and their data. Do not downgrade or rebuild
the SQLite schema, and do not run an older binary against a database newer
than its migration set. Existing unassigned conversations, legacy schedules,
project/global memory, and task history remain inspectable; pending runs and
outbox rows can be resumed by a compatible release.

## Verification evidence

On the 2026-08-20 working tree:

- `cd services/orchestrator && npx vitest run --maxWorkers=4` — **232 files, 2,380 passed, 5 skipped**.
- `cd apps/web && npx vitest run` — **59 files, 402 passed**.
- `cd packages/contracts && npx vitest run` — **7 files, 85 passed**.
- Focused parity suites (`scheduled-routines`, `schedules`, `recovery`,
  `memory-ownership`, `group-conversations`, `group-security-regressions`,
  `thread-handoffs`, and MCP/cancellation coverage) — **13 files, 111 passed**;
  the focused web teammate/schedule/memory set — **7 files, 47 passed**.

Browser acceptance used the local stack (`pnpm dev:app`) at
`http://127.0.0.1:4318/app/`: `/app/` covered roster identity and live status;
`/app/chats/<conversationId>?projectId=<projectId>` covered group participants,
bounded handoff/evidence, and cancellation states; `/app/skills` covered routine
edit/run, schedule history, and notification preferences; `/app/memory`
covered scope/ownership and quarantine truth. Responsive checks used desktop,
tablet, and 390px mobile geometry. MCP server/permission and cancellation
checks were deterministic local/API suites; no external login or hosted cloud
computer was used. The session's reproduce notes remain in
[the AI-teammates continuation](../tasks/agent-teammates-continuation.md).

### Explicit limitations

This ADR makes no claim to reproduce exact proprietary internals or private
Grok behavior; it records Morrow's tested, local-first equivalents. Model-authored
browser/authentication flows are deterministic-only acceptance paths. Morrow
does not read browser cookies, claim that an external model can complete a
provider login, or treat credential/payment entry as an autonomous browser
capability.
