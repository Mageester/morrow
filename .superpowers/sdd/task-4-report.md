# Task 4 Implementation Report — Resumable Web Mission Stream

Status: DONE

Commit: `6541c1da952a46a8aac0c1b5aafa08ffc06c8f7a`

Base: `4674fff53d0f1a7128ae5f6e5197ab2fc6b63c2d`

## Implementation

- Added `services/orchestrator/src/web/mission-stream.ts`.
- Registered `registerWebMissionStreamRoutes` immediately after the Task 3 web mission routes in `services/orchestrator/src/server.ts`.
- Added `services/orchestrator/test/server-web-stream.test.ts`.
- Polling uses persisted mission events after the last sent cursor.
- Resume cursor is the maximum valid value from query `after` and `Last-Event-ID`.
- Unknown missions and invalid cursors fail before SSE headers are sent.
- Stream event IDs use persisted mission-event sequence numbers.
- Idle heartbeats emit comments and do not mutate cursor state.
- Poll and heartbeat timers are cleared when the request closes.
- Initial implementation sent event ID, raw event type, and summary. Independent review found that persisted summaries could contain commands or credential-bearing URLs; the review-fix section below supersedes this behavior with an exact `{ eventId }` payload.

## TDD evidence

Initial focused run failed because `../src/web/mission-stream.js` did not exist.

Final recorded commands and results:

- `npx vitest run test/server-web-stream.test.ts` — 1 file, 7 tests passed.
- `npx vitest run test/server-web-stream.test.ts test/server-web-missions.test.ts` — 2 files, 16 tests passed; clean exit; no open-handle warning.
- `pnpm --filter @morrow/orchestrator check` — TypeScript clean, exit 0.

Coverage includes ordered unique events, reconnect from cursor 2, maximum of query/header cursors, structured invalid-cursor 400, unknown-mission 404 before stream headers, heartbeat cursor stability, exact SSE framing, schema parsing, and delivery of an event appended after stream open.

## Design decisions and deviations

- Reused existing `sseIntervalMs` for polling; added injectable `webStreamHeartbeatMs` with production default 15 seconds.
- Tests seed missions directly to obtain deterministic event sequences because `MissionService.create` appends multiple events.
- Event classification maps approval-like events to `attention.updated`, evidence/artifact/checkpoint events to `artifact.updated`, lifecycle events to `runtime.updated`, and remaining events to `mission.updated`.

## Files changed

- `services/orchestrator/src/server.ts`
- `services/orchestrator/src/web/mission-stream.ts`
- `services/orchestrator/test/server-web-stream.test.ts`

## Self-review

- No tracked or staged residue after commit.
- `.superpowers/` intentionally remained outside implementation commit.
- No known Critical or Important concerns reported by implementer.

---

## Review-fix report — 2026-07-19

Status: FIXED AND VERIFIED

Commit: `e499d2a86591af4b7af25d6c1eb04a6cc373ea23`

### Fixes

- Reduced every browser SSE payload to exactly `{ eventId }`. Persisted summaries,
  raw mission-event types, event data, commands, URLs, provider names, and model
  names are not serialized into the browser envelope.
- Added `missions.listEventsAfter(missionId, afterSequence)` backed by
  `WHERE mission_id = ? AND sequence > ? ORDER BY sequence ASC`; the stream now
  forwards its current cursor to that bounded query and never hydrates complete
  mission history.
- Validated the raw-response pattern against installed Fastify `5.8.5` docs and
  behavior. The route validates cursor and mission first, then calls
  `reply.hijack()` before writing SSE headers.
- Centralized idempotent shutdown. Request close, response close, response error,
  repository exceptions, and response-write exceptions clear timers/listeners;
  internal failures destroy (or safely end as a fallback) the already-hijacked
  response without attempting a structured JSON response.
- Added explicit backpressure state. A non-throwing `write()` advances the event
  cursor because Node has accepted the chunk into its output buffer; `false`
  pauses later events, polling, and heartbeats behind exactly one `drain`
  continuation. Drain resumes one heartbeat timer and one poll path.
- Preserved the 15-second production heartbeat default, maximum resume cursor,
  monotonic event IDs, no duplicates, heartbeat cursor stability, and pre-header
  structured 400/404 behavior.

### Strict TDD evidence

All focused cycles used:
`pnpm --filter @morrow/orchestrator test -- server-web-stream.test.ts`.

- Secret-boundary RED: 1 file; 2 failed, 6 passed. Exact frames still contained
  raw type and credential-bearing summary. GREEN: 1 file; 8 passed.
- Repository-method RED: 1 file; 1 failed, 8 passed
  (`missions.listEventsAfter is not a function`). GREEN: 1 file; 9 passed.
- Cursor-forwarding RED: 1 file; 1 failed, 9 passed (bounded method had 0 calls).
  The first green attempt exposed a test timing race (1 failed, 9 passed); after
  waiting for the next poll, GREEN: 1 file; 10 passed.
- Fastify lifecycle RED: 1 file; 2 failed, 10 passed (no hijack; response close
  did not stop polling). GREEN: 1 file; 12 passed.
- Failure containment RED: 1 file; 3 failed, 12 passed, plus 2 unhandled timer
  exceptions (repository and write); responses remained undestroyed. GREEN:
  1 file; 15 passed, with no unhandled errors.
- Header-write containment RED: 1 file; 1 failed, 17 passed (a hijacked
  `writeHead` exception left the response open). GREEN: 1 file; 18 passed.
- Backpressure RED: 1 file; 2 failed, 15 passed (both buffered events were
  written after `false`; heartbeats reached 4 without drain). GREEN: 1 file;
  17 passed.
- An intermediate typecheck correctly rejected the synthetic test event type;
  the test was changed to the real `mission.criterion_verified` contract value.

### Final verification

- `pnpm --filter @morrow/orchestrator test -- server-web-stream.test.ts server-web-missions.test.ts`
  — PASS, 2 files and 27 tests, exit 0, no open-handle or unhandled-error warning.
- `pnpm --filter @morrow/orchestrator check`
  — PASS, TypeScript exit 0.
- `git diff --check`
  — PASS, exit 0.

### Security, deletion, and rollback

- Security impact: closes the critical browser-secret boundary and fails closed
  after streaming begins. This security-sensitive change still requires an
  independent security review before merge under `AGENTS.md`/`SECURITY.md`.
- Deleted-mission case: not applicable. Repository/source search found no
  supported production mission-deletion interface; only migration tests issue
  direct SQL deletes. No deletion behavior was added solely for this stream test.
- Known limitations: polling remains cadence-based and event queries are not
  page-limited; they are now cursor-bounded as required.
- Rollback: revert the review-fix commit. This restores the previous stream and
  removes the new repository method/tests without a schema or data migration.
