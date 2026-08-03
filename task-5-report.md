# Task 5 report: durable completion contracts and review corrections

## Result

Task 5 is implemented on `codex/reliable-task-completion` with a single
evidence-driven completion evaluator for the four declared task shapes. The
agent evaluates the contract at the provider-turn boundary before stagnation
accounting, closes verified work without an extra provider request, and
replays the same decision from durable checkpoint/mission evidence after
restart. The review corrections keep mission evidence owned by the current
task or an explicit recovery lineage, give delivery intent precedence over
review wording, validate durable browser results, and prevent denied or failed
tool calls from becoming read-only evidence. Durable assistant-message,
provider-turn, and canonical-answer sinks also redact credential-like final
text before it can be persisted or replayed. Task events and provider
continuations apply the same recursive redaction before durable storage, while
the web activity boundary sanitizes streamed narration defensively. The final
hardening also sanitizes object keys, ignores attacker-controlled serializers
and accessors, converts cycles/non-JSON values to stable JSON-safe placeholders,
and closes the assistant-message read, FTS, and web projection paths for legacy
rows without altering user-message content. Provider-turn tool-call JSON,
canonical-answer evidence, task tool-call arguments/results, task continuation
arguments, background-process arguments, route metadata, and checkpoint
structured fields now share the same durable JSON sanitation boundary. The
role-aware FTS migration rebuilds legacy message rows and preserves user search.

## TDD evidence

- RED: before `completion-contract.ts` existed, the new contract suite ran 8
  tests and failed all 8 with the intentional missing-module assertion.
- RED integration reproduction: the verified CLI fixture completed only after
  7 provider requests because repeated `read_process_output` polling happened
  before completion was recognized; the test expected 3 requests.
- GREEN: the same integration fixture now completes after exactly 3 provider
  requests and records only the write plus two verification calls.
- GREEN: the coverage table asserts exact registry/evidence equality for
  `read_only`, `file_delivery`, `cli_application`, and
  `frontend_application`.
- Failed final verification, narration/existence-only delivery, unresolved
  requirements, incomplete frontend evidence, and checkpoint serialization
  are covered as non-completion cases.
- Review RED: 7 expected failures in a 33-test run reproduced the three
  browser-result false-completion cases and four denied/failed-observation
  cases.
- Review GREEN: the same focused run passed 33/33 after the production fixes;
  the lineage and mixed-shape RED/GREEN cases also remained green.
- P1 restart RED: the exact three-case crash-replay fixture reproduced the
  restart defect with 1 failure/2 expected blockers: an unchanged persisted
  CLI artifact was interrupted because replay ran before task evidence was
  restored.
- P1 restart GREEN: the unchanged artifact completed with zero provider calls;
  changed and missing artifacts both interrupted with zero provider calls
  (3/3).
- P1 privacy RED: the live and crash-replay final-answer regressions both
  persisted the exact probe `credential sk-abcdefghijklmnop` raw in the
  provider turn, canonical answer, and assistant message (2 failures).
- P1 privacy GREEN: both paths now persist `credential ***redacted***` in all
  three SQLite sinks, with no provider call added during replay.
- P1 event/continuation RED: four exact nested-data checks failed: task-event
  payloads, web narration, provider continuation `state_json`, and the real
  agent event stream all retained `credential sk-abcdefghijklmnop`.
- P1 event/continuation GREEN: all four checks pass; raw SQLite event and
  continuation rows, loaded continuation state, and projected activity contain
  only redacted values while route-fingerprint lookup remains unchanged.
- P1 serializer/assistant-index RED: four exact probes failed: cyclic/custom
  event payloads, cyclic/custom continuation state, assistant append/read/web
  behavior, and assistant FTS indexing all exposed or could persist the raw
  probe.
- P1 serializer/assistant-index RED: the pre-privacy database reopen fixture
  separately failed 1/1 because a legacy assistant row and its FTS copy stayed
  raw.
- P1 serializer/assistant-index GREEN: all five probes pass; keys and values
  are redacted, getters/toJSON are never invoked, cycles/non-JSON values are
  stable placeholders, legacy rows are migrated, assistant search hits are
  safe, user content remains unchanged, and routeFingerprint behavior is
  preserved.
- Review RED: the five new durable-boundary probes produced 7 failures in the
  54-test focused set (provider-turn/canonical evidence, task tool calls,
  collision-safe keys, checkpoint/route fields, and role-only FTS behavior).
  The scoped mission-export and task-continuation audit probes added 2 more
  expected failures before their boundary fixes.
- Review GREEN: the same boundary probes passed 9/9 after implementation;
  direct raw-input provider projection passed, and the background-process
  argument audit passed its 11-test suite. Legacy rows are sanitized on reads,
  task APIs, compaction projection, mission export, and FTS rebuild.

## Verification

| Check | Result |
| --- | --- |
| Focused Task 5 brief command (5 files) | 64/64 passed |
| New provider/canonical/tool/FTS/collision/export/continuation probes | 10/10 passed |
| Background-process JSON privacy suite | 11/11 passed |
| Focused privacy/replay regression | 2/2 passed |
| Event/web/continuity RED/GREEN regression | 4/4 passed after fix |
| Focused restart/review compatibility run (5 files) | 122/122 passed |
| Privacy, continuity, security, and restart regressions (6 files) | 55/55 passed |
| Event/web/privacy/continuity/restart/security regressions (11 files) | 111/111 passed |
| Serializer/assistant-index RED/GREEN regression | 5/5 passed after fix |
| Event/task-records/continuity/web/search/diagnostics/privacy/security/restart/requirements run (20 files) | 283/283 passed |
| Replay/restart/completion-order/checkpoint matrix (8 files) | 66/66 passed |
| Restart/recovery, completion-order, progress, requirements, security, and checkpoint regressions (21 files) | 267/267 passed |
| Review-focused completion/frontend/security run (3 files) | 33/33 passed |
| Broader completion/restart/non-progress/requirements/security run (16 files) | 319/319 passed |
| 247-test regression set (9 files) | 247/247 passed |
| Full default `@morrow/orchestrator` suite | 166 files, 1,753/1,753 passed |
| `pnpm --filter @morrow/orchestrator check` | passed |
| `pnpm --filter @morrow/contracts check` | passed |
| Default live-isolated behavior (included in full orchestrator suite) | passed; no provider call |
| Explicit live isolation (`MORROW_SKIP_LIVE_FLAGSHIP=1 pnpm flagship:run`) | 1/1 passed; no provider call |
| `git diff --check` | passed |

The full-suite first pass exposed 14 compatibility failures in answer-only,
fallback, plan-mode, restart, and sustained-mission paths. The runtime now
preserves answer-only completion when no evidence contract applies, while
keeping strict read-only evidence checks for inspection/tool turns. Mission
recovery turns import independently recorded progress evidence from the
mission ledger, preserving completion across task restarts. The final full
suite is fully green, including crash-replay and privacy coverage.

## Security and privacy

- Evaluation is deterministic and local; no provider, network, telemetry, or
  hosted dependency was added.
- Existing tool permissions, approval handling, provider selection, and
  read-only restrictions remain in force.
- Mission progress is imported only when it has durable operation ownership
  matching the current task or an explicit recovery lineage. Browser route,
  DOM, console/page-error, interaction, viewport, and screenshot evidence is
  accepted only from successful, parseable durable results.
- Mode-denied calls remain available for answer-only compatibility, but cannot
  satisfy an inspection contract; failed and approval-blocked calls are never
  independent evidence.
- Credential-like final text is redacted at assistant-message, provider-turn,
  canonical-answer, task-tool-call, continuation, and background-process
  persistence boundaries; ordinary final-answer text and completion evidence
  semantics remain unchanged.
- Task event payloads are recursively redacted before SQLite serialization and
  on reads; object keys are sanitized and custom prototypes, `toJSON`, getters,
  symbols, cycles, and non-JSON values cannot reintroduce raw data.
- Continuation state is recursively redacted before JSON storage and on load,
  preserving opaque state shape and route-fingerprint selection; cyclic and
  non-JSON values use stable JSON-safe placeholders.
- Assistant content is redacted on repository writes and reads, FTS writes and
  legacy migration, search result projection, and web message projection.
  User-message writes and safe search content remain unchanged.
- Role-only user-to-assistant updates refresh both FTS title/body projections;
  migration 46 rebuilds the message partition, sanitizes legacy assistant
  content, and retains user-message searchability.
- Live-provider execution was not authorized. Both live checks ran through
  their isolation paths, and no live run was appended.
- No secrets or raw provider credentials were logged or added to the diff.

## Evidence integrity

`docs/evidence/flagship-runs.jsonl` was not modified. Its final size is 875
bytes and its SHA-256 is:

`0FE914A924AC3B780299ECBC7000831A447E630AAA5EFDD2B7E2A0C8E3FC3A5A`

## Rollback

Revert this focused privacy-hardening commit only with a database-aware
rollback plan: migrations 45 and 46 are recorded in `schema_migrations`, and redacted
legacy values cannot be recovered without a database backup. No evidence
file rollback is required; the append-only live evidence file remains
untouched.
