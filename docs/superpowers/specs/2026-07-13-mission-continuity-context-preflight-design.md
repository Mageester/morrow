# Mission Continuity and Context Preflight Design

## Status

Approved for implementation on `fix/mission-continuity-context-preflight`.
This document is an implementation checkpoint, not evidence that the incident is fixed.

## Objective

Make advanced Morrow missions continue safely across turn budgets, context
pressure, provider route limits, recoverable provider failures, and orchestrator
restarts without routine user `/continue` input. Preserve the existing mission,
task, event, provider, and Execution Kernel boundaries.

## Confirmed incident causes

1. `executeAgentChatTask` stores streamed text in the whole-task
   `responseContent` accumulator and appends that accumulator as the content of
   every assistant tool turn. The projected history therefore grows as
   `turn1`, `turn1+turn2`, `turn1+turn2+turn3`, rather than one discrete entry
   per turn. Tool calls for the task are also attached to one conversation
   assistant message, so restart reconstruction cannot recover their original
   turn boundaries.
2. Context resolution consults advertised model metadata but does not identify
   or constrain the actual endpoint/gateway route. A model advertised as one
   million tokens can therefore be sent through an endpoint enforcing 131,072.
3. Preflight counts normalized chat messages only. Tool definitions and
   provider-required continuation fields are omitted, while tool overhead is a
   fixed per-tool reserve rather than the serialized request cost.
4. Restart recovery converts running tasks to terminal `interrupted` tasks and
   deliberately does not re-dispatch them. Adaptive turn exhaustion uses the
   same terminal path. `/continue` then reconstructs the same oversized state.

## Invariants

- Durable mission/task records are authoritative; provider conversations are
  deterministic projections of durable records.
- Each assistant turn, tool call, and tool result has one durable identity and
  appears at most once in a provider projection.
- Full raw tool records remain durable. Compaction changes only the provider
  projection and stores references to the raw records.
- A provider is never invoked unless the complete projected request plus output
  reserve fits the effective limit for that exact route.
- Internal checkpoints, compactions, segment boundaries, route switches, and
  restarts are non-terminal execution events.
- Approval, credential, user budget, unrecoverable external failure, and
  material product ambiguity are the only routine human interruption classes.
- Opaque provider continuation fields are stored separately from summaries and
  UI payloads. They are never logged, rendered, indexed, or interpreted as
  Morrow reasoning.
- No hidden chain-of-thought is placed in checkpoints or final answers.
- Mission completion remains gated by authoritative requirements, persisted
  verification evidence, resolved blockers, review, and one canonical result.

## Route-aware effective context

Add one pure route resolver used by task routing, provider construction,
preflight, task aggregates, `/context`, and diagnostics. Its result contains:

- selected and canonical model identifiers;
- provider identifier and adapter protocol;
- normalized endpoint route kind and safe endpoint host;
- advertised model capacity and source;
- configured or known endpoint limit and source;
- effective request limit and source;
- requested output reserve and source;
- maximum input tokens;
- every safety/fallback limit that participated in the minimum.

The effective request limit is the minimum positive verified limit applicable
to the actual route. Built-in endpoint metadata applies only to its exact
default route. A custom endpoint does not inherit the default endpoint's limit;
it uses an explicit per-provider endpoint override when configured, otherwise a
conservative fallback marked as such. Unknown advertised or endpoint values
remain `null` in public diagnostics. No universal 131,072 or one-million-token
constant is introduced.

Endpoint limits are configurable with the existing provider configuration
mechanism and environment-backed secrets file. The limit is non-secret
metadata, validated as a positive integer, hot-applied, and removed with the
provider configuration. Existing configurations remain valid and acquire the
route-specific default or conservative fallback.

## Complete provider preflight

Introduce a canonical provider request envelope and pure measurement function.
The envelope contains messages, tool definitions, output reserve, protocol,
model, and private continuation fields. Measurement includes:

- all system and mission-contract instructions;
- user and discrete assistant messages;
- tool definitions, tool-call arguments, and tool results;
- compacted checkpoint/summary messages;
- provider-required continuation fields, including DeepSeek
  `reasoning_content` when present;
- provider-specific framing/protocol overhead;
- requested output tokens and the configured safety margin.

Exact tokenization is used only where supported and remains labelled exact.
Other routes use the conservative deterministic estimator and expose that
confidence. Admission compares the measured input against `maximumInputTokens`,
where the output reserve has already been deducted from the effective request
limit.

All provider entry points, including fallback candidates and mission planning
or review calls, pass through this admission gate. A rejected request produces
no provider call. Fallback candidates are measured against their own route, not
the primary route's limit.

## Durable non-amplifying turn projection

Migration 32 adds versioned execution state without modifying historical
migrations:

- `agent_execution_segments`: task/mission identity, monotonically increasing
  segment number, phase/status, durable event cursor, route snapshot, lease,
  timestamps, and terminal/non-terminal reason.
- `agent_provider_turns`: task and segment identity, monotonically increasing
  turn number, discrete assistant text for that turn, tool-call id list,
  private continuation reference, final-answer flag, and timestamps.
- `agent_execution_checkpoints`: versioned structured checkpoint JSON, source
  event cursor, projection cursor, reason, route snapshot, and timestamps.
- `agent_provider_continuations`: opaque provider protocol JSON, route/model
  binding, source turn, and timestamps. Repository APIs never return the opaque
  payload through task aggregates.
- `canonical_task_answers`: unique task id, optional mission id, source turn,
  answer text, evidence cursor, and timestamp.

Unique constraints enforce one segment number per task, one turn number per
task, one canonical answer per task, and one active segment lease per task.
Migration compatibility tests cover fresh databases and databases at migration
31. If migration validation fails, the transaction rolls back completely.

Provider turns are persisted before tool execution. Tool calls continue to use
`message_tool_calls` as their raw authoritative records and are referenced by
id from the turn. Projection joins each referenced result once. A completed
tool record is replayed as observation only and is never executed again.
Ambiguous in-flight tool execution after a crash is checkpointed as unresolved;
file/change-set state is reconciled by durable hashes before any retry.

The visible conversation assistant message remains the streaming presentation
surface. Provider reconstruction never parses that cumulative presentation
text; it uses discrete provider turns. On success, the durable canonical answer
is the single authoritative user-facing result.

## Structured checkpoint

Before compaction, segment rollover, provider-route recovery, or safe restart,
persist a checkpoint containing concise structured values for:

- original mission and identifiers;
- hard requirements, prohibited actions, and acceptance criteria;
- decisions/trade-offs and completed work;
- current phase and durable cursor;
- changed files and exact Git status;
- tests/commands run with exact persisted outcomes;
- unresolved failures and recovery attempts;
- pending work;
- approval and permission state;
- route/model resolution and private continuation references;
- last durable event cursor;
- evidence still required for completion.

The checkpoint stores references to full durable outputs rather than embedding
large raw results. Requirements and unresolved failures are represented
structurally and are never discarded by compaction.

## Compaction and segmentation

Preflight runs before every call. When the projected request reaches a
configurable threshold below maximum input, Morrow:

1. persists or updates the structured checkpoint;
2. closes the current execution segment as a non-terminal boundary;
3. replaces older narration and redundant tool output in the provider
   projection with the checkpoint plus durable record references;
4. retains recent raw turns and route-bound continuation fields;
5. remeasures the complete request;
6. opens the next segment and continues automatically only if it fits.

Compaction is idempotent by source cursor and content hash. Rebuilding a
projection without new durable events produces byte-equivalent logical input
and the same token count.

Adaptive turn-budget exhaustion follows the same checkpoint/segment path. It
does not transition the task or mission to a terminal state and does not emit a
terminal SSE event. Loop/stall detection and user-defined budget limits remain
real interruption boundaries.

## Restart and provider-failure recovery

Startup reconciliation distinguishes resumable checkpointed agent tasks from
unknown in-flight work. A resumable task is claimed with a durable lease and
re-dispatched before the service accepts duplicate execution. Its durable
cursor prevents repeated turns, tool writes, and task events.

If the service stopped between checkpoint persistence and provider invocation,
the segment is resumed from the checkpoint without inventing a completed call.
If it stopped after a turn or tool result became durable, reconstruction starts
after that cursor and reuses the observation.

A recoverable provider failure closes the route-bound segment, checkpoints the
failure, and opens a fresh segment on an eligible route. Opaque continuation
state is reused only when provider, canonical model, protocol, and route binding
match; otherwise the fresh route receives the structured checkpoint projection.
An unexpected provider context rejection after successful local preflight is
recorded as route-limit evidence, triggers one stricter compaction/fresh-segment
attempt, and never loops unchanged.

## CLI behavior

- `/context`, status, and task reports display model capacity, endpoint limit,
  effective limit, reserved output, maximum input, current request, sources,
  and exact/estimated confidence from the shared resolver/preflight record.
- `/continue` invokes the same recovery/preflight path. It compacts first when
  possible and returns a specific local refusal without provider invocation
  when recovery cannot fit.
- Automatic segment continuation does not require `/continue`.
- `/clear` clears only rendered terminal state and immediately states that
  saved/provider context is unchanged.
- `/compact` requests durable provider-projection compaction; it is distinct
  from screen clearing.
- Recovery suggestions never recommend `/continue` for a deterministic
  unchanged oversize state.

## Completion ownership

The task can write its canonical answer only from a final provider turn. The
unique record makes retry/restart idempotent. For a mission-linked task,
checkpoint and segment events never satisfy mission criteria. Existing Mission
Service grading remains authoritative and is strengthened so a full completion
requires evaluated authoritative requirements, persisted successful
verification, no unresolved blocker, an applicable review, and the canonical
answer/evidence cursor. Verification failure after recovery keeps the mission
non-complete and eligible for repair within its existing review budget.

## Tests and acceptance

Focused tests implement all 22 requested regressions, with red/green evidence.
The decisive integration scenario uses an advertised one-million-token model on
an effective 131,072-token route, crosses multiple turn/context segments,
restarts the orchestrator, encounters a recoverable provider failure, preserves
requirements and workspace changes, avoids duplicate events/writes, runs
verification, and produces exactly one evidence-backed final result without
user `/continue` input.

The required CLI/orchestrator/workspace checks, builds, full tests, diff checks,
independent requirements review, and hostile failure review run before the final
implementation commit and pull request.

## Privacy, security, and rollback

This change touches provider routing, external data flow, unattended execution,
and durable continuation state and therefore requires explicit hostile security
review. Endpoint URLs remain sanitized in public data. Opaque continuation
payloads are excluded from logs, FTS, diagnostics exports, events, summaries,
and API aggregates.

Rollback is a normal code revert plus application restart. Migration 32 is
additive; older binaries will ignore its tables. No existing conversation,
mission, task, event, tool result, or checkpoint record is deleted or rewritten.
