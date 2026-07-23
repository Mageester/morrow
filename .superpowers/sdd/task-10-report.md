# Task 10 Report — Honest Attention and Recovery States

## Scope

Implemented the browser-side attention, error, runtime reconnection, and
recovery surfaces for the existing web mission vertical slice:

- typed attention resolution through the existing mission-owned endpoint;
- complete attention cards with explicit consequences and unrelated-work state;
- confirmation for destructive choices with no implicit decision;
- authoritative snapshot cache replacement plus mission-query invalidation;
- safe actionable API-error conversion and a global route render boundary;
- runtime reconnecting state and honest mission failure, recovery, and
  verification summaries;
- Overview integration and responsive styles.

No orchestrator, controller, contract, shared UI, lockfile, permission,
packaging, deployment, authentication, or provider behavior changed.

## TDD Evidence

### Initial RED

Before production modules existed:

```powershell
pnpm --filter @morrow/web test -- attention-card.test.tsx runtime-status.test.tsx error-boundary.test.tsx
```

Observed exit code `1`: all three suites failed import resolution for the
missing `attention-card.js`, `mission-status.js`, and `error-boundary.js`
modules. No tests ran, which was the intended missing-feature failure.

### Focused GREEN

After the minimum attention, state, and boundary implementation:

```text
pnpm --filter @morrow/web test -- attention-card.test.tsx runtime-status.test.tsx error-boundary.test.tsx
PASS — 3 files, 27 tests
```

### Integration RED → GREEN

Overview integration was removed before adding its behavior tests. The focused
mission test then failed for exactly two missing surfaces: no recommended
attention action and no recoverable-failure summary.

```text
pnpm --filter @morrow/web test -- mission-page.test.tsx
RED — 1 file, 2 failed / 9 passed
GREEN — 1 file, 11 passed
```

A second regression cycle replaced raw runtime API messages in both initial
load and background synchronization paths. Both new assertions failed before
conversion was wired and passed afterward.

A final security/contract cycle failed on a secret-bearing structured 400
message and the missing explicit `What happened` field. Static client-error
copy and the complete attention definition list made the focused suites green:

```text
pnpm --filter @morrow/web test -- attention-card.test.tsx error-boundary.test.tsx
PASS — 2 files, 16 tests
```

## Final Verification

Fresh final run after all implementation and security changes:

```text
pnpm --filter @morrow/web test
PASS — 10 files, 141 tests

pnpm --filter @morrow/web check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/web build
PASS — Vite 8.1.3, 2018 modules transformed, built in 1.11s
       dist/index.html: 0.50 kB (0.31 kB gzip)
       JS: 449.66 kB (133.97 kB gzip)
       CSS: 17.13 kB (3.55 kB gzip)

Test-Path apps/web/dist/index.html
PASS — True

git diff --check 3bac5202f1e1cc6e1b14e22241c5d96cf5daa9ce
PASS — no whitespace errors
```

## Security and Ownership Review

- Attention decisions are never preselected, automatically invoked, or
  retried by TanStack Query. Every mutation begins with an explicit user
  action.
- Both `missionId` and `attentionId` are independently URL-encoded. A request
  whose projected mission ownership differs from the rendered mission is
  inert. Successful response snapshots are also rejected unless every nested
  mission reference matches the requested mission.
- A synchronous submission guard prevents double submission before React
  exposes pending state. All choices and the note are disabled while the one
  mutation is pending.
- The returned schema-validated authoritative snapshot enters the exact detail
  cache. A response cannot replace a cache entry with a later activity cursor
  or update timestamp. Mission list/detail queries are then invalidated.
- Conflict, not-found, unsupported-choice, ownership-mismatch, and server
  failures keep the request, note, and choices visible. No failure is treated
  as a successful durable decision.
- The optional note is included because the existing
  `ResolveWebAttentionSchema` and orchestrator route already support and
  persist it. Empty notes are omitted; the field is capped at 1,000 characters
  and warns against credentials.
- Structured API errors use static browser-safe explanations. Server messages,
  unknown exception messages, stacks, paths, and secret-like content are not
  rendered. Trace IDs are shown only when they match a small safe-character
  allowlist.
- No state-changing retry, permission expansion, cross-project lookup,
  telemetry, browser storage, hosted dependency, or external data flow was
  added.

## Accessibility Review

- Attention cards use ordered headings and an explicit definition-list
  contract for what happened, why it matters, recommendation, and unrelated
  work. Choices form a labelled group and each button is described by its
  consequence.
- Recommended choices receive visible and semantic emphasis through text and a
  data state; they are not toggles and never use a selected or pressed state.
- Destructive choices open an `alertdialog` with an accessible name,
  description, and modal state. Focus starts on Cancel, Tab is contained,
  Escape and Cancel close the dialog, and focus returns to the invoking choice.
  Confirm is guarded so repeated activation submits exactly once.
- The global fallback is focusable and receives focus after a render error.
  A successful explicit retry restores focus to the application main region.
- Attention content and operational summaries are not live regions. Only the
  pending mutation uses a polite status, and a failed mutation uses one shared
  actionable alert, avoiding per-field announcement flooding.
- Reconnecting copy is visible text and the existing runtime status region
  remains polite. Failure, verification, recovery, and recommendation meaning
  never depends on color alone.

## Honest State and Privacy Review

- Waiting approval, external blocker, expired connection, and provider
  unavailable are rendered from typed attention requests without fabricated
  actions.
- Runtime unavailable and reconnecting are based only on health/browser events;
  no progress, timing, or recovery estimate is invented.
- Recoverable/permanent failure and verified/unverified completion are derived
  from projected mission and verification state.
- Interrupted/resumed display uses only the browser-safe projected recovery
  summary. Raw activity detail remains hidden. Because the current contract
  does not project checkpoint or replay fields, the UI states that those
  details were not reported instead of inventing them.

## Limitations

- The orchestrator currently resolves only projected `approve` and `deny`
  choices. Other contract-valid choices remain visible and submit explicitly,
  but the current server rejects them safely with `INVALID_CHOICE`; the request
  remains usable.
- The health endpoint reports orchestrator availability only. Provider outages
  are represented when the authoritative mission attention/API state reports
  them; the browser does not probe providers independently.
- The browser recovery projection has no structured interrupted target,
  checkpoint, replay, or next-step fields. Task 10 therefore shows the safe
  recovery summary and explicitly reports that missing detail.

## Rollback

Revert `feat(web): add honest attention and recovery states`. This removes only
the Task 10 web API helper, attention/error/state components and tests,
provider/Overview wiring, runtime reconnecting copy, styles, and this report.
Persisted approvals, mission/controller state, contracts, shared UI,
orchestrator behavior, and package output remain unchanged.

## Review Hardening

The review follow-up closes six failure and honesty gaps without changing the
server contract, shared UI package, or persistence model:

- An unknown destructive POST outcome now requires an authoritative mission
  refresh. If the request has disappeared, the refreshed snapshot is cached
  and the decision is never posted again. If it remains pending, destructive
  confirmation is shown again before any new POST.
- Attention resolution and recovery refreshes use one synchronous,
  mission-scoped coordinator. While one card owns it, every choice and note in
  that mission is disabled, preventing concurrent responses from arriving out
  of order or resurrecting older attention state.
- React 19 caught and uncaught root errors emit only a fixed message, error
  kind, and local correlation ID. Raw errors, component stacks, secrets, and
  paths are neither rendered nor logged by Morrow handlers.
- Error cards no longer offer a placeholder diagnostics action. Failed
  decisions offer the real `Refresh mission state` operation and never retry a
  state-changing request automatically.
- Recovery copy reports only the current snapshot verification enum and states
  explicitly that post-recovery verification trust was not reported.
- Error-boundary focus returns to healthy application content only after a
  successful retry. A replacement fallback cancels stale animation-frame work
  and keeps focus on the new error card; unmount also cancels pending work.

### Review TDD Evidence

The first focused RED run failed 10 new assertions across the four review
suites. The persistent-boundary test was then strengthened separately and
failed because `cancelAnimationFrame(42)` had not occurred. After implementing
the first five fixes, the focused run reached 31 passing tests with three stale
assertions; correcting those assertions produced 34/34 passing tests.

The mission serialization test was added before its coordinator. Its RED run
failed because the provider export was absent. After adding the shared lock and
wiring the mission attention list, the focused attention suite passed 13/13.
The combined review suite then passed 35/35.

### Review Verification

Fresh checks after all hardening changes:

```text
pnpm --filter @morrow/web test
PASS — 11 files, 149 tests

pnpm --filter @morrow/web check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/web build
PASS — Vite 8.1.3, 2018 modules transformed
       dist/index.html: 0.50 kB (0.31 kB gzip)
       JS: 452.48 kB (134.74 kB gzip)
       CSS: 17.13 kB (3.55 kB gzip)
```

Security impact is limited to safer client-side handling: no new data leaves
the browser, no permission boundary changes, and no raw exception data is
persisted or emitted by the new handlers. The authoritative refresh uses the
existing mission-owned read endpoint and validates all nested mission IDs.

Accessibility impact: mission-wide busy state is reflected by disabled native
controls; destructive confirmation remains explicit; successful retry focus
targets only healthy main content; persistent errors retain alert focus.

Known limitation: the current response contract has no idempotency key or
operation-status endpoint. A lost mutation response therefore requires an
explicit authoritative refresh before the user can decide whether to act
again. Post-recovery verification provenance is also not projected, so the UI
reports that limitation instead of inferring trust.

Rollback the review hardening with
`git revert <fix(web): harden attention and recovery safety commit>`. This
restores the original Task 10 client behavior without changing server data,
contracts, or durable attention decisions.

### Review Race Follow-up

The component-local serialization lock still allowed a navigation remount to
start a second decision while the first request was in flight. Task 10 cache
writes also relied on server timestamps/activity cursors, which are not a
client-side ordering guarantee, and the recovery refresh wrote its response
unconditionally.

The coordinator now stores per-mission state in a `WeakMap` keyed by the
TanStack `QueryClient`. A monotonic operation generation therefore survives
provider unmount/remount without leaking beyond that cache lifetime. Each
operation captures the exact detail-query identity and `dataUpdateCount` at
start. Its mutation or recovery snapshot is committed only when both still
match and its generation still owns the mission. Any intervening stream,
detail, or background cache update wins; Task 10 does not intercept or block
those writers. Task 10 invalidation uses `refetchType: none`, marking affected
queries stale without launching another unguarded response race.

TDD RED reproduced both paths:

```text
pnpm --filter @morrow/web test -- attention-card.test.tsx
FAIL — 1 file, 2 failed / 13 passed
       remounted card was enabled during the old POST
       stale refresh replaced attention-current with attention-original
```

Focused GREEN after the durable generation/CAS implementation:

```text
pnpm --filter @morrow/web test -- attention-card.test.tsx
PASS — 1 file, 15 tests
```

Fresh full verification for this follow-up:

```text
pnpm --filter @morrow/web test
PASS — 11 files, 151 tests

pnpm --filter @morrow/web check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/web build
PASS — Vite 8.1.3, 2018 modules transformed
       dist/index.html: 0.50 kB (0.31 kB gzip)
       JS: 453.35 kB (135.05 kB gzip)
       CSS: 17.13 kB (3.55 kB gzip)
```

Security and privacy impact: no new network request, storage, logging, or data
flow was added. The ordering state contains only mission/attention identifiers
and in-memory counters scoped to the existing QueryClient. Accessibility
behavior is unchanged except that a remounted card correctly remains disabled
while the prior mission decision is unresolved.

Limitation: ordering is local to one QueryClient/browser runtime. Server-side
idempotency remains the correct future boundary for decisions submitted by
multiple clients. Roll back this follow-up by reverting its focused commit;
durable server state and prior Task 10 hardening are unaffected.
