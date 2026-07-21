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

## Final verification

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

- The API supports an optional deadline, which is exposed inside progressive
  disclosure. Attachment upload and connection selection do not have a truthful
  API in this slice, so the UI explicitly says they are unavailable rather than
  presenting non-functional controls.
- Mission workspace activity, attention resolution, and richer mission cards
  remain later tasks; this change does not implement Task 8+ behavior.

## Rollback

Revert commit `feat(web): add universal mission composer` to restore the Task 6
Home placeholder and remove the project-selection query helper.
