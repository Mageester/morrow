# Task 4 Independent Review — Initial

## Spec compliance

Verdict: NEEDS FIXES.

Cursor resolution, ordering, reconnect behavior, heartbeat framing, and pre-header 400/404 handling match the brief. Browser payload is not secret-safe.

## Critical

`services/orchestrator/src/web/mission-stream.ts:91` sends persisted `event.summary` directly to the browser. Verification summaries can contain verbatim commands or credential-bearing URLs. Omit or redact summaries and add a credential regression test.

## Important

1. `services/orchestrator/src/web/mission-stream.ts:147` calls `listEvents(missionId)` and filters in memory. Repository SQL loads complete mission history every 100ms. Add `WHERE mission_id = ? AND sequence > ? ORDER BY sequence` query.
2. Raw response ownership lacks `reply.hijack()`. Timer callbacks lack error cleanup/backpressure handling. Hijack the reply, stop on request/response close or error, and pause polling when writes signal backpressure.

## Minor

Unknown-mission test does not cover a create-then-delete case. Only add this if deleted missions are supported.

## Strengths

- Strict cursor parsing and max(query, header) selection.
- 400/404 happen before stream headers.
- Mission-scoped sequence ordering and heartbeat cursor stability.
- Live tests cover backlog, post-connect delivery, reconnect, framing, and heartbeats.

## Assessment

Task quality: NEEDS FIXES.

Core resume behavior is sound, but browser-secret boundary and stream lifecycle require correction before approval.

---

# Task 4 Independent Re-review — Final

## Verdicts

- Specification compliance: APPROVED.
- Code quality: APPROVED.
- Security review: APPROVED.
- Critical findings: 0.
- Important findings: 0.

## Initial-finding disposition

1. Browser secret exposure: fixed. Browser SSE payloads contain only the coarse event category and `{ eventId }`; credential-bearing persisted summaries and event data are excluded. A wire-level regression test covers this boundary.
2. Repeated full-history querying: fixed. `listEventsAfter(missionId, cursor)` now uses `sequence > ? ORDER BY sequence ASC`, and the stream forwards its accepted cursor.
3. Raw response lifecycle and backpressure: fixed. Validation occurs before `reply.hijack()` and header writes; cleanup is idempotent across close/error/failure paths; polling and heartbeats pause behind one drain continuation.

## Fresh evidence

- `pnpm --filter @morrow/orchestrator test -- server-web-stream.test.ts server-web-missions.test.ts`: 2 files, 27 tests passed.
- `pnpm --filter @morrow/orchestrator check`: passed.
- `git diff --check 4674fff..e499d2a`: passed.

## Open finding

- Minor: `listEventsAfter` returns the complete remaining backlog and maps fields the browser stream does not use. Add ordered pagination and a narrow select in future hardening if large backlogs become material.

## Final assessment

Task quality: APPROVED. No Critical or Important findings remain.
