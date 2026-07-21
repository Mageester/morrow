# Task 7 Report — Home and Universal Mission Composer

## Scope

Implemented the Task 7 Home surface and universal mission composer only. The
default flow is objective-first, uses one Morrow identity, has no task-category
picker, creates missions through the typed `/api/web/missions` boundary, and
navigates to the existing mission route after success.

## TDD evidence

### RED

`pnpm --filter @morrow/web test -- home-page.test.tsx`

Before implementation, the new `home-page.test.tsx` suite failed (9/9 tests).
The Task 6 placeholder lacked the accessible `Mission objective` input,
universal prompt, mission creation flow, mission sections, and project states.

### GREEN

`pnpm --filter @morrow/web test -- home-page.test.tsx`

Passed: 1 file, 9 tests. Coverage includes prompt/category absence, empty
submission, Enter and Shift+Enter behavior, rapid double submit locking,
stable retry keys, key rotation after an explicit failed-draft edit, success
navigation and cache population, failure preservation, section order/hiding,
safe project states, and focus/accessibility semantics.

## Initial verification (before reviewer hardening)

- `pnpm --filter @morrow/web test` — passed, 4 files / 35 tests.
- `pnpm --filter @morrow/web check` — passed.
- `pnpm --filter @morrow/web build` — passed; Vite emitted `dist/index.html`
  and the expected hashed assets.
- `git diff --check` — passed.

## Files

- `apps/web/src/api/projects.ts`
- `apps/web/src/features/home/home-page.tsx`
- `apps/web/src/features/home/mission-composer.tsx`
- `apps/web/src/features/home/home-page.test.tsx`

## Privacy, security, and accessibility

- `/api/projects` is schema-validated, then reduced to only `id` and `name`
  before it enters the browser query cache. Workspace paths, project details,
  and secrets are not persisted or rendered.
- Mission creation validates its outgoing input with `CreateWebMissionSchema`
  and validates responses with `WebMissionSnapshotSchema`.
- A ref-level in-flight lock prevents rapid Enter events from starting two
  requests before React mutation state re-renders. The idempotency key remains
  stable across retries and changes only after success or a user edit after a
  failed request.
- The composer has an explicit textarea label, a keyboard submit/newline split,
  automatic focus once a project is ready, status/error live semantics, and
  disabled unavailable actions.

## Limitations and deviations

- The service does not yet persist a mission deadline. The deadline input is
  explicitly disabled/unavailable and is not submitted. Attachment upload and
  connection selection likewise have no truthful API in this slice.
- Mission workspace activity, attention resolution, and richer mission cards
  remain later tasks; this change does not implement Task 8+ behavior.

## Rollback

Revert commit `feat(web): add universal mission composer` to restore the Task 6
Home placeholder and remove the project-selection query helper.

---

## Reviewer hardening follow-up

### RED

`pnpm --filter @morrow/web test -- home-page.test.tsx`

The reviewer regression suite expanded Home coverage from 9 to 15 tests. Before
the hardening implementation it failed 8 tests: active deadline submission,
autonomy edits reusing a failed key, oversized-objective handling, duplicate
attention/active placement and whitespace-derived landmark ids, contradictory
project status copy, and a late create success overriding user navigation.

### GREEN

`pnpm --filter @morrow/web test -- home-page.test.tsx`

Passed: 1 file, 15 tests. The resolved tests cover disabled/no-payload deadline
behavior, objective and autonomy idempotency rotation after failure, stable
retry keys, 8,000-character rejection and exact-boundary acceptance without a
stuck submission lock, exclusive attention/active/recent partitions, fixed
named landmarks, project loading/error/empty announcements, and a late success
that caches but does not navigate after Home unmounts.

### Privacy and accessibility correction

The raw `/api/projects` response necessarily reaches the browser to be
schema-validated. `projectQueries.list` immediately maps it to `id` and `name`
before React Query/application state retains it, so `workspacePath` is neither
rendered nor stored in client query state. A future browser-safe project
projection endpoint would remove this raw-response exposure; it is deliberately
out of scope for Task 7.

Deadline, attachment, and connection controls are now explicitly unavailable
in this local slice and are not submitted. Validation errors are announced via
an alert and mark the objective invalid. Project states use distinct polite
loading/empty announcements and an assertive error without contradictory
composer copy.

### Follow-up rollback

Revert commit `fix(web): harden mission composer behavior` to remove only the
reviewer hardening changes while retaining the original Task 7 feature.

---

## Final composer error-semantics follow-up

### RED

`pnpm --filter @morrow/web test -- home-page.test.tsx`

The focused suite failed two regressions: a recoverable API failure marked a
valid objective `aria-invalid` and described the textarea with the request
error, while the objective-validation message did not have its dedicated
description id.

### GREEN

`pnpm --filter @morrow/web test -- home-page.test.tsx`

Passed: 1 file, 15 tests. API/runtime failures now remain a polite, accessible
form status without invalidating a valid objective. Objective validation alone
sets `aria-invalid`, describes the textarea with `mission-objective-error`, and
clears when the user corrects the draft.

### Current final verification

- `pnpm --filter @morrow/web test` — passed, 4 files / 41 tests.
- `pnpm --filter @morrow/web check` — passed.
- `pnpm --filter @morrow/web build` — passed with `apps/web/dist/index.html`.
- `git diff --check a68f912c3efdf24ae39e1cb8051c832901ff75b1..HEAD` — passed.

### Final rollback

Revert commit `fix(web): separate composer validation errors` to remove only
the final validation/request-error accessibility separation.
