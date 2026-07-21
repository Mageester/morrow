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
