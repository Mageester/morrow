### Task 8: Build Mission Overview and Activity with Live Resumption

**Files:**
- Create/modify mission page, overview, activity, stream client, and tests.

**Interfaces:**
- Consumes: `GET /api/web/missions/:id` and SSE stream.
- Produces: `useMissionStream(missionId)` that applies ordered events, invalidates the authoritative snapshot, and reconnects from the last acknowledged cursor.

- [ ] **Step 1: Write stream-client and UI tests**

Prove that duplicate cursor 4 is ignored, cursor 6 after cursor 4 triggers a full snapshot refetch because cursor 5 was missed, reconnect uses `?after=4`, and the UI announces meaningful state changes without announcing every heartbeat.

- [ ] **Step 2: Implement ordered client handling**

```ts
if (envelope.cursor <= lastCursorRef.current) return;
if (envelope.cursor !== lastCursorRef.current + 1) {
  queryClient.invalidateQueries({ queryKey: missionKeys.detail(missionId) });
}
lastCursorRef.current = envelope.cursor;
queryClient.invalidateQueries({ queryKey: missionKeys.detail(missionId) });
```

Use exponential reconnect delay capped at 15 seconds. Display `Reconnecting…` after one failed reconnect and `Offline — showing last synchronized state` when `navigator.onLine` is false.

- [ ] **Step 3: Implement Overview**

Overview must answer objective, completed milestones, current work, attention needed, and remaining milestones. Render milestone counts and states; do not calculate a numeric percent.

- [ ] **Step 4: Implement Activity**

Render human-readable items collapsed by default. An expandable technical inspector may show actor, artifact references, event ID, and timestamp, but not private model chain-of-thought.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @morrow/web test -- mission-page.test.tsx mission-stream.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/mission-stream.ts apps/web/src/features/missions
git commit -m "feat(web): add live mission overview and activity"
```

---

