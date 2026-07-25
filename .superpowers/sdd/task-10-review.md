# Task 10 Independent Review

Base: `3bac5202f1e1cc6e1b14e22241c5d96cf5daa9ce`

Head: `3396792d166b1983221adf2a5b74abe57ac5d566`

Reviewed range: `3bac520..3396792` (3 commits `99ed33e`, `e4b5e7d`, `3396792`).
Complete package: `review-3bac520..3396792.diff` (18 files, +2549/-48).

## Review history

- Initial implementation `99ed33e` passed 27 focused tests. Independent review
  found six Important issues: destructive retry bypass, concurrent cache
  resurrection, raw React error logging, fake diagnostics action, unsupported
  recovery-verification assurance, and retry focus theft.
- Fix wave `e4b5e7d` (TDD) closed five of six. Re-review left one Important
  race finding: attention-resolution serialization was component-local, so a
  navigation remount or background refetch could start a second decision or
  overwrite newer attention state, and cache writes trusted server
  timestamps/activity cursors instead of a client-side ordering guarantee.
- Final fix `3396792` moved per-mission operation state into a `WeakMap` keyed
  by the TanStack `QueryClient` (durable across provider unmount/remount,
  bounded by that cache lifetime). Each operation captures the detail query's
  identity and `dataUpdateCount` at start; its mutation or recovery snapshot is
  committed only when the same generation still owns the mission **and** the
  detail-query identity and `dataUpdateCount` are unchanged (compare-and-swap).
  Any intervening stream/detail/background write therefore wins. Invalidation
  uses `refetchType: "none"` so no new unguarded refetch race is launched.

## Verification of the final race finding

The final fix targets exactly the remaining Important finding and nothing more
(only `attention-card.tsx`, its test, and the report changed in `3396792`).

- Cross-remount lock is proven by `attention-card.test.tsx` → "keeps an
  in-flight mission lock across unmount and rejects its late snapshot": the
  remounted card is disabled while the prior POST is in flight, no second POST
  is issued, the late success snapshot is CAS-rejected (cache keeps the
  intervening `current` snapshot), and the lock is released after the POST
  settles (no permanent lock).
- Client-side ordering is proven by "does not let a stale recovery refresh
  overwrite an intervening mission update": a refresh response bearing a *newer
  server timestamp* but stale content is rejected because `dataUpdateCount`
  changed after acquire; the intervening update stands.

## Dimension verdicts

- Specification: APPROVED. Attention cards render the full contract (what
  happened / why it matters / recommendation / choices+consequences / unrelated
  work); destructive choices require an `alertdialog`; recommendations are
  emphasized but never auto-selected; `toErrorCard` matches the brief and is
  extended safely; all required runtime/failure/recovery/verification states
  are represented from typed projections.
- Code quality: APPROVED. Idiomatic house style; `useSyncExternalStore` for the
  shared coordinator; typed CAS; no meaningful duplication.
- Accessibility: APPROVED. Definition-list contract, labelled choice group,
  `aria-describedby` consequences, focus-trapped modal with focus restoration,
  emphasis not by color alone, single actionable error alert, polite pending
  status, mission-wide busy reflected by disabled native controls.
- Security & privacy: APPROVED. No raw error/stack/secret rendered or logged
  (static client copy, allowlisted trace IDs, fixed root/boundary messages);
  dual URL-encoding plus deep response ownership validation; no new network,
  storage, telemetry, retry, permission, or external data flow; note capped at
  1,000 chars and warned against credentials.
- Race safety & authoritative-cache behavior: APPROVED. Durable per-mission
  serialization, CAS reconciliation, and non-racing invalidation as verified
  above.

## Final verdict

- Critical: 0.
- Important: 0.
- Minor (non-blocking, not fixed): (1) the inner per-`missionId` map in
  `resolutionStates` is never pruned within a `QueryClient` lifetime — bounded
  by distinct missions visited and released with the `QueryClient`; the report
  documents this local-scope limitation and names server-side idempotency as
  the correct future boundary. (2) `main.tsx` correlation IDs use `Date.now()`
  — browser-appropriate, no secret content.

## Fresh evidence (re-run during recovery)

- `pnpm --filter @morrow/web test`: 11 files, 151 tests passed.
- `pnpm --filter @morrow/web test attention-card.test.tsx`: 15 tests passed
  (includes both race regressions above).
- `pnpm --filter @morrow/web check`: passed (`tsc -p tsconfig.json`).
- `pnpm --filter @morrow/web build`: passed; JS 453.35 kB, `apps/web/dist`
  emitted.
- `git diff --check 3bac520..HEAD`: clean.
- `packages/ui` not touched by Task 10; UI gates deferred to the final gate.

## Assessment

Task quality: APPROVED. Task 10 is review-clean with zero open Critical or
Important findings.
