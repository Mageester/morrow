### Task 4: Add a Resumable Ordered Mission Event Stream

**Files:**
- Create: `services/orchestrator/src/web/mission-stream.ts`
- Modify: `services/orchestrator/src/server.ts`
- Test: `services/orchestrator/test/server-web-stream.test.ts`

**Interfaces:**
- Produces: `GET /api/web/missions/:missionId/stream?after=<cursor>` using `text/event-stream`.
- Stream event IDs are monotonically increasing mission-event sequence numbers.
- Reconnect accepts the larger of `after` and `Last-Event-ID`.

- [ ] **Step 1: Write stream tests**

Prove that:

1. events are ordered and never duplicated;
2. reconnect from cursor 2 starts at cursor 3;
3. an invalid cursor returns structured 400;
4. a deleted/unknown mission returns 404 before stream headers are sent;
5. heartbeat comments do not mutate the cursor.

Expected SSE frame:

```text
id: 3
event: mission.updated
data: {"version":1,"cursor":3,"missionId":"mission-1","eventType":"mission.updated","emittedAt":"2026-07-19T12:00:03.000Z","payload":{"eventId":"event-3"}}

```

- [ ] **Step 2: Run focused stream tests and confirm failure**

```bash
pnpm --filter @morrow/orchestrator test -- server-web-stream.test.ts
```

Expected: FAIL with route not found.

- [ ] **Step 3: Implement stream cursor resolution and framing**

```ts
export function resolveResumeCursor(queryAfter: unknown, lastEventId: unknown): number {
  const parse = (value: unknown): number => {
    if (value === undefined || value === null || value === "") return 0;
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
    return parsed;
  };
  return Math.max(parse(queryAfter), parse(lastEventId));
}

export function encodeSse(envelope: WebMissionStreamEnvelope): string {
  return `id: ${envelope.cursor}\nevent: ${envelope.eventType}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
```

The polling loop must query persisted mission events after the last sent cursor, not subscribe only to in-memory events. Close timers on socket close. Send `: heartbeat\n\n` every 15 seconds when idle.

- [ ] **Step 4: Run stream tests and orchestrator suite subset**

```bash
pnpm --filter @morrow/orchestrator test -- server-web-stream.test.ts server-web-missions.test.ts
pnpm --filter @morrow/orchestrator check
```

Expected: PASS with no open-handle warning.

- [ ] **Step 5: Commit**

```bash
git add services/orchestrator/src/web/mission-stream.ts services/orchestrator/src/server.ts services/orchestrator/test/server-web-stream.test.ts
git commit -m "feat(orchestrator): add resumable web mission stream"
```

---

