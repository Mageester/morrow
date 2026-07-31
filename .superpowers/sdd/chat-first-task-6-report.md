# Task 6 report — Chat-first shell and Home

Base commit: `48b7727`. Branch `feat/morrow-web-app-foundation` (PR #64, kept open/draft/unmerged).

## Objective delivered

Replaced the mission-first prototype shell and Home with a production chat-first foundation backed only by real local data, and added a durable Chats surface with a real New chat flow. Reviewed Slice 1–5 security and lifecycle boundaries are untouched (no changes to conversation dispatch, streaming, idempotency, provider credentials, or draft isolation).

## Implementation

- **Three-way theme** (`state/theme.tsx`): `useTheme()` now returns `{ preference, resolvedTheme, setTheme }` over `light | dark | system`, persisted under `morrow-theme`. A single stable `matchMedia("(prefers-color-scheme: dark)")` subscription follows live OS changes **only** while the preference is `system`; an explicit choice always wins. `resolvedTheme` is applied to `document.documentElement`. The existing pre-paint `index.html` script already resolves `system`/unknown via `matchMedia`, so there is no incorrect flash. `settings-page.tsx` exposes a Light/Dark/System segmented control (`role="group"`, `aria-pressed`).
- **New chat** (`features/chat/new-chat-button.tsx`): creates exactly one conversation through the existing project-scoped `conversationApi.create`, navigates to `/chats/$conversationId?projectId=`, and lets the destination composer autofocus. A synchronous in-flight ref plus `isPending` prevents double creation from a double click or rerender. No project → the control is disabled with an explanation and never mounts the router hook. Failure shows a `role="alert"` with a manual **Try again**; nothing auto-retries or silently loses intent.
- **Chats** (`features/chat/chats-page.tsx`, route `/chats`): project-scoped Active/Archived tabs over `conversationApi.list(projectId, includeArchived)`, rows link to `/chats/$conversationId?projectId=`, with loading, honest empty, retained-cache warning, and a retryable error. No rename/delete/archive controls are exposed here (out of slice scope; no dead controls).
- **Home** (`features/home/home-page.tsx`): time-based greeting, a prominent New chat entry, real "Continue where you left off" tiles from recent conversations, an "Active work" summary from active missions, and honest loading/empty/error/no-project states. No hardcoded mock prompts.
- **Shell + navigation** (`app/app-shell.tsx`, `app/router.tsx`): chat-first destinations **Home · Chats · Projects · Missions · Library · Memory · Connections · Settings**. Projects and Memory are not built yet, so they are honest disabled controls with a "Soon" badge (never fake pages). Recent conversations render in the sidebar (resilient: nothing on empty/error). Active route keeps `aria-current="page"`; title + main focus update on navigation; a skip link remains. A mobile top bar toggles an off-canvas drawer (`aria-expanded`, Escape to close, scrim, focus to main on route change). The obsolete `/automations` and `/workspace` `ComingSoonPage` routes were removed.
- **Styles** (`styles/app.css`): additive block for the new nav/recent/upcoming items, New chat, Home tiles + mission rows, Chats list/tabs, empty/inline-error, the theme control, and a `max-width: 760px` drawer/responsive tier (44px touch targets, single-column, no horizontal overflow) plus a reduced-motion guard.

## Test/harness notes

- The prior RED test `new-chat-button.test.tsx` used two **synchronous** `getByRole` queries immediately after mounting `RouterProvider`, which mounts asynchronously in this stack (verified: a bare `<button>` under `RouterProvider` fails sync `getByRole` but passes async `findByRole`; `app-shell`/`chats-page` tests already use `findBy`). Those two lines were switched to `await findByRole` — the assertions (single create, canonical navigation, focus, error+retry) are unchanged.
- `home-page.test.tsx` and `app-shell.test.tsx` were rewritten to the new chat-first contract (the old versions asserted the removed mission composer / mission-first nav).
- `MissionComposer` is now dormant (Home no longer mounts it; mission creation moves into the conversation in a later slice). Its core guarantees are preserved by a new focused `mission-composer.test.tsx` (empty-block, single create on double submit, no-provider note) so the component is never silently untested.

## Privacy / security impact

- No provider credentials, secrets, or workspace paths reach the browser; `projectQueries.list` continues to drop `workspacePath`. Theme persistence writes only `morrow-theme`. Recent-chat and New-chat data stay project-scoped. No Slice 1–5 boundary (dispatch idempotency, SSE cursors, credential handling, draft isolation) was modified.

## Commands / results

- `vitest run` (web): **22 files, 188 tests passed**.
- `tsc -p tsconfig.json`: clean (fixed an `exactOptionalPropertyTypes` violation on `NewChatButtonProps`).
- `tsc -p tsconfig.node.json && vite build`: built (2024 modules, `index-*.css` 46.9 kB).
- Real-browser acceptance (Chromium via Playwright against seeded `/api`): Home (light/dark), Chats (Active/Archived), Settings theme control, and 390px mobile drawer render correctly. Screenshots in `docs/redesign/slice6-acceptance/`. Manually inspected each per the user's "browser-inspect before done" rule.

## Known limitations

- Packaged Playwright nav coverage (desktop keyboard + mobile touch across all destinations) and full-suite E2E were not re-run here; acceptance used the real production components under Chromium with route-seeded data. `mission-vertical-slice.spec.ts` still lists the old nav labels + Home mission composer and will need updating with the packaged E2E refresh.
- Projects and Memory are honest "Soon" controls, not pages (their slices are later).
- The pre-existing unrelated mobile mission-result snapshot drift (Slice 4/5 note) is untouched.

## Rollback

`git revert <this commit>` restores the mission-first shell/Home and removes `/chats`, the theme rewrite, and the styles block. No data migration is involved (frontend-only, plus additive CSS); reverting is safe and complete.
