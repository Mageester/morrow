# Task 8 Report — Live Mission Overview and Activity

## Scope

Implemented the Task 8 mission workspace slice:

- authoritative, Zod-validated mission snapshot loading through the existing
  `missionQueries.detail` query;
- a resumable `useMissionStream(missionId)` EventSource client for the four
  named server event categories;
- Overview and Activity tabs backed only by the browser-safe web projection;
- accessible Overview, Activity, Work, and Result tab wiring, with Work and
  Result retained as honest later-slice placeholders;
- loading, typed API failure, unknown-mission, retry, offline, reconnecting,
  and synchronized states.

No orchestrator, contract, shared UI, lockfile, authentication, permission, or
Task 9 Work/Result behavior was changed.

## TDD Evidence

### RED

The required page and stream tests were written before production code.

```powershell
pnpm --filter @morrow/web test -- mission-page.test.tsx mission-stream.test.ts
```

The first run exited `1`. All seven mission-page tests failed against the Task 6
placeholder because the authoritative query, Overview, Activity, tabs, loading,
error, retry, and live-announcement behavior did not exist.

The stream test initially revealed a test-authoring syntax error: its required
`.ts` filename contained JSX. The harness was corrected to use `createElement`
without touching production code. The valid stream RED was then captured with:

```powershell
pnpm --filter @morrow/web test -- mission-stream.test.ts
```

It exited `1` because `./mission-stream.js` did not exist. This was the expected
feature-missing failure.

### GREEN

After the minimal stream and workspace implementation:

```text
pnpm --filter @morrow/web test -- mission-page.test.tsx mission-stream.test.ts
PASS — 2 files, 12 tests
```

The focused coverage proves:

- all four custom named SSE categories are listened to rather than relying on
  the default `message` event;
- every envelope is parsed with `WebMissionStreamEnvelopeSchema` and rejected
  when malformed, for another mission, mismatched to its event category,
  duplicated, or older than the accepted cursor;
- a duplicate cursor 4 is ignored and cursor 6 after cursor 4 performs the gap
  invalidation plus the normal accepted-event invalidation;
- reconnect starts at `?after=4`, mission IDs are URL encoded, retries are
  exponential and capped at 15 seconds, and only one source/timer remains live;
- source, timer, and browser listeners are cleaned on mission change/unmount;
- offline mode refrains from connecting and uses the exact required status,
  while online resumes from the last accepted cursor;
- Overview answers objective, completed work, current work, attention, and
  remaining work with milestone counts/states and no numeric percentage or
  time estimate;
- Activity is human readable and collapsed by default, and its technical view
  exposes only actor, artifact references, event ID, cursor, and timestamp;
- meaningful state/activity snapshot changes use one atomic polite
  announcement, while default/heartbeat traffic produces no snapshot request
  or announcement;
- loading, empty data, typed API failure, unknown mission, and manual query
  retry remain explicit and testable;
- the four tabs implement named tablist/tab/tabpanel semantics, roving tab
  focus, ArrowLeft/ArrowRight wrapping, Home/End, and honest placeholders.

## Final Verification

```text
pnpm --filter @morrow/web test
PASS — 6 files, 53 tests

pnpm --filter @morrow/web check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/web build
PASS — Vite 8.1.3, 2012 modules transformed, built in 1.93s
       dist/index.html: 0.50 kB (0.31 kB gzip)
       JS: 432.80 kB (129.57 kB gzip)
       CSS: 13.41 kB (2.97 kB gzip)

Test-Path apps/web/dist/index.html
PASS — True

git diff --check 425944e2f324da305031888e68b71bfef507f84e
PASS — no whitespace errors across the cumulative Task 8 diff
```

## Stream Lifecycle Review

- The stream keeps its accepted cursor inside one mission-scoped effect. It is
  retained across reconnects but resets on mission change.
- An EventSource error closes the browser-managed source before scheduling the
  explicit retry, preventing native EventSource retry and application retry
  from overlapping.
- The retry timer is cleared before offline transitions and during cleanup.
  Online events cannot create a second source or timer.
- Each listener verifies that its source is still the active source, so closed
  or superseded source callbacks cannot change state or invalidate queries.
- Browser `Last-Event-ID` replay is harmless because any replayed cursor at or
  below the last accepted cursor is ignored. The explicit `after` cursor is
  also included on every newly created source, and the server selects the
  larger resume cursor.
- Heartbeat comments are not EventSource messages. No default `message`
  listener exists, so heartbeats do not alter state or create announcements.

## Accessibility Impact

- Four named tabs use a named `tablist`, `tab`, `aria-selected`,
  `aria-controls`, roving `tabIndex`, and labelled `tabpanel` relationship.
- Arrow keys, Home, and End both select and focus the expected tab; click/touch
  selection remains available with 44px minimum targets.
- Loading and synchronization states are status regions. Typed load failures
  use the existing accessible `ErrorCard` and a keyboard-operable retry.
- Snapshot state and latest-activity changes are combined into one
  `aria-live="polite"`, `aria-atomic="true"` update rather than announcing
  every stream envelope or heartbeat.
- Activity uses native collapsed `details`/`summary`, and milestone states are
  expressed in text rather than color alone.
- Responsive styles reduce the Overview grid to one column and keep tabs
  horizontally reachable on narrow screens.

## Privacy and Security Impact

- The same-origin EventSource URL carries only an encoded mission ID and a
  numeric cursor. No credential, token, content, or private state is placed in
  the URL or browser storage.
- Every SSE data envelope is JSON parsed and strictly schema validated before
  use. The browser retains only the numeric accepted cursor in the live effect;
  payload records are never copied into React state, query data, logs, or DOM.
- Stream envelopes only invalidate the authoritative snapshot query. They do
  not mutate the cached mission from untrusted payload data.
- Activity `detail` is deliberately not rendered because it may contain raw
  internal material. The technical inspector is allowlisted to actor name,
  artifact IDs, projected activity/event ID, cursor, and timestamp.
- Live announcements use only the projected mission UI state label and
  `summary.latestActivity`; no raw payload or model reasoning is announced.
- No telemetry, analytics, external inference, hosted dependency, storage key,
  permission change, or new external data flow was added.

## Deviations and Deliberate Exclusions

- The approved mission header also anticipates elapsed time and mission control
  actions. They were excluded because this slice requires no numeric time
  estimate and the current web contract exposes no pause/resume/cancel action.
- Attention is summarized read-only. Resolution controls and fuller recovery
  stories remain assigned to Task 10.
- Work and Result are ARIA-complete tab placeholders only; Task 9 owns their
  real inspection, artifact, evidence, and result experiences.
- Raw activity `detail`, provider metadata, cost/token data, commands, and tool
  payloads are not exposed because the current browser-safe contract does not
  provide a proven allowlisted projection for them.
- No rendered browser screenshot was added. The isolated web test environment
  has no persisted live mission fixture; semantic DOM, keyboard, stream, and
  responsive behavior are covered by the focused tests, while packaged visual
  QA remains a later end-to-end gate.

## Limitations

- The stream starts only after an authoritative mission snapshot succeeds, so
  an unknown mission does not enter an infinite stream reconnect loop.
- The cursor is intentionally in-memory and mission-scoped; a full page reload
  starts at zero and the server supplies its durable backlog.
- Reconnect status is intentionally coarse. It does not expose internal socket
  errors or retry counts to the user.
- The Activity tab is limited to the server-projected `recentActivity` window;
  pagination or a complete history endpoint is not part of this slice.
- Rich pause/resume/cancel controls, attention resolution, recovery actions,
  artifacts, Work, and Result are deferred to their assigned tasks.

## Rollback

Revert `feat(web): add live mission overview and activity`. This restores the
Task 6 mission placeholder and removes only the browser stream hook, Task 8
mission components/tests/styles, and this report. The server stream, contracts,
shared UI package, orchestrator state, persisted mission data, and lockfile are
unchanged.

---

## Important Review Fix Pass

Date: 2026-07-21

### Review-Fix Scope

- A failed background snapshot refetch no longer replaces a cached mission with
  the blocking initial-load error. The last synchronized workspace remains
  rendered, its existing EventSource remains mounted, and a non-blocking polite
  synchronization warning exposes a retry.
- Skipped milestones are now neither hidden nor counted as completed. They have
  a separate visible bucket and state label, and the displayed completed,
  remaining, skipped, and total counts reconcile.
- All four tabpanels now remain in the DOM with stable IDs matching each tab's
  `aria-controls`. Only the selected panel is visible; inactive panels use the
  native `hidden` state while preserving `aria-labelledby` relationships.

### Review-Fix RED Evidence

Tests for all three Important findings were added before production changes.

```powershell
pnpm --filter @morrow/web test -- mission-page.test.tsx mission-stream.test.ts
```

Observed result:

- exit code `1`;
- 1 test file failed and 1 passed;
- 3 tests failed and 12 passed;
- skipped-milestone count/bucket was absent;
- three inactive tabs controlled IDs with no corresponding panel;
- a failed invalidation refetch replaced the cached workspace with the blocking
  ErrorCard and unmounted the live stream.

These were the intended behavior failures from the review findings.

### Review-Fix GREEN Evidence

```text
pnpm --filter @morrow/web test -- mission-page.test.tsx mission-stream.test.ts
PASS — 2 files, 15 tests
```

The new regressions prove that:

- initial success followed by SSE invalidation and a typed 503 retains the
  mission objective, shows no blocking alert, preserves the same open
  EventSource instance, provides `Retry synchronization`, and clears the
  warning after a successful authoritative retry;
- a skipped milestone appears only in the Skipped bucket with a Skipped state,
  and `2 completed + 3 remaining + 1 skipped` reconciles to `6 total`;
- every tab's `aria-controls` resolves to a stable `tabpanel`, every panel points
  back through `aria-labelledby`, the selected panel is visible, and all
  inactive panels are hidden;
- the original arrow, Home/End, click, overview, activity, stream, privacy, and
  error tests remain green.

### Review-Fix Accessibility Impact

- Background synchronization failure uses `role="status"`,
  `aria-live="polite"`, and `aria-atomic="true"` rather than an assertive
  blocking alert. Its visible text explains that the last synchronized state is
  shown, and its retry is a native keyboard-operable button.
- Cached content and the user's selected tab do not disappear during a
  background transport/API failure.
- Tabs now satisfy the complete `tab -> aria-controls -> tabpanel ->
  aria-labelledby -> tab` relationship for all four views at all times.
  Inactive content is excluded from interaction and the accessibility tree by
  the native `hidden` attribute.
- Skipped is conveyed in visible text and a dedicated list, not by color or by
  omission, and is never announced or presented as completed work.

### Review-Fix Privacy and Security Impact

- The warning renders only the existing typed safe API message; it does not
  expose a response body, stream payload, trace internals, or cached private
  detail.
- Preserving the stream does not create an additional source or timer. The same
  mission-scoped source and cursor continue while the authoritative query retry
  is user-controlled.
- No storage, authentication, permissions, external data flow, telemetry,
  contracts, orchestrator, or shared UI boundary changed.

### Review-Fix Final Verification

```text
pnpm --filter @morrow/web test -- mission-page.test.tsx mission-stream.test.ts
PASS — 2 files, 15 tests

pnpm --filter @morrow/web test
PASS — 6 files, 56 tests

pnpm --filter @morrow/web check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/web build
PASS — Vite 8.1.3, 2012 modules transformed, built in 2.14s
       dist/index.html: 0.50 kB (0.31 kB gzip)
       JS: 433.83 kB (129.79 kB gzip)
       CSS: 13.73 kB (3.01 kB gzip)

Test-Path apps/web/dist/index.html
PASS — True

git diff --cached --check 425944e2f324da305031888e68b71bfef507f84e
PASS — no whitespace errors across the complete staged Task 8 range
```

### Review-Fix Limitations and Rollback

- The warning remains visible during an explicit retry until a successful
  snapshot replaces the query error; React Query still deduplicates the request.
- Revert `fix(web): preserve mission state and tab semantics` to remove only
  this review-fix pass while retaining the original Task 8 implementation.
