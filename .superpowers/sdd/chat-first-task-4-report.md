# Task 4 — Production chat composer report

## Status

Implementation complete locally; independent security review remains required before merge because this change intentionally stores user-authored drafts. The reusable chat composer and its draft boundary are implemented, tested, and ready for Task 5/6 integration. No branch was pushed. The report, task brief, Playwright CLI session files, screenshots, and other controller evidence remain untracked and are not part of the implementation commit.

## Design and interface

- `ChatComposer` owns one stable, uncontrolled textarea. Parent renders do not assign `value`, change a React key, or replace the node, so the browser retains its native cursor, selection, clipboard, IME, and undo/redo behavior.
- `onSubmit` is the persistence boundary. It receives exact text plus project/conversation, backend `mode`/`autoApprove`, and a real preset or explicit provider/model selection. It must return `{ accepted: true }` before the editor or persisted draft is cleared.
- Ask maps to `read-only`; Plan to `plan-only`; Build to `agent` with `autoApprove: false`; Build Auto to `agent` with `autoApprove: true`.
- Project and route controls are native selects backed by caller-provided real IDs/options. The default is the existing `balanced` preset. Task 7 can replace the native route control with the full catalogue without changing the submission contract.
- Stop is rendered only when both an active task ID and a cancellation callback exist. Every non-submit control is `type="button"`.
- Attachment UI is intentionally absent. A short note explains that the current message API has no file field, so there is no no-op affordance.
- The current Home mission textarea narrowly reuses the project-scoped draft store so the existing packaged harness can verify navigation/reload recovery before Task 6 replaces the Home surface. It preserves the existing mission contract and 8,000-character limit; the new chat boundary uses the backend `SendMessageSchema` limit of 32,000.

## RED / GREEN evidence

- RED: `pnpm.cmd --filter @morrow/web exec vitest run src/features/chat/draft-store.test.ts src/features/chat/chat-composer.test.tsx --maxWorkers=1`
  - Expected failure: both production modules were missing; 2 suites failed during import.
- GREEN: the same focused command passed: 2 files, 15 tests.
- Additional RED: focused whitespace-only send test failed because length alone enabled send.
- Additional GREEN: sendability now uses trimmed content; the full focused suite remained 15/15.
- Home reuse RED: focused navigation/remount test lost the draft.
- Home reuse GREEN: the project-scoped draft is restored without overwriting text entered while projects are still loading.
- Current full unit gate: `pnpm.cmd --filter @morrow/web test -- --maxWorkers=1` passed: 15 files, 187 tests.
- Current type check and production build passed.
- Current dedicated composer gate passed in both configured projects: four desktop Chromium tests and one mobile Chromium touch test; project-inapplicable cases were skipped.
- The default `pnpm.cmd --filter @morrow/web e2e` runner always executes both the production suite and dedicated composer suite. Its composer suite passed 5/5; the production suite passed 15 tests and failed only the pre-existing mobile result screenshot baseline (expected height 2221px, stable actual height 2197px). No snapshots were updated because Task 4 does not own that result-page baseline.
- `git diff --check` passed.

## Browser evidence

- `e2e/composer-harness.html` is a Vite-only test entry that imports the production `ChatComposer`. It is neither a production router route nor a production build input and contains no duplicate composer implementation.
- Desktop Chromium verifies zero-delay typing, Home/End/arrows and selection, Ctrl+A/C/X/V, undo/redo, multiline/URL/code/Unicode/emoji input, exact 32,000-character insertion, held Backspace, IME 229, Shift+Enter/Enter, exact rejection retention, scoped reload recovery, scope transitions, stale outcomes, focus/selection restoration, selectors/callback payloads, active-task gating, and autosize/internal scrolling.
- The dedicated mobile Chromium project sets `isMobile: true`, `hasTouch: true`, DPR 2.75, Android mobile user agent, and a 390×844 viewport. It performs real `tap()` interactions, enforces a 44×44px send target, reduces the viewport to 390×500 to simulate keyboard pressure, re-taps the visible textarea, verifies internal scrolling and no horizontal overflow, and inspects the exact production `env(safe-area-inset-bottom)` CSS declaration.
- Headless Chromium does not expose a physical nonzero safe-area environment inset on this Windows host. Evidence is therefore limited honestly to the exact production CSS rule, its nonzero fallback padding, and the reduced mobile layout; a physical notched-device inset remains hardware/browser integration coverage.
- Final listener checks confirmed both dedicated ports 4373 and 4381 free.

## Files

- `apps/web/src/features/chat/chat-composer.tsx`
- `apps/web/src/features/chat/chat-composer.test.tsx`
- `apps/web/src/features/chat/draft-store.ts`
- `apps/web/src/features/chat/draft-store.test.ts`
- `apps/web/src/features/home/mission-composer.tsx`
- `apps/web/src/features/home/home-page.test.tsx`
- `apps/web/src/styles/app.css`
- `apps/web/e2e/composer.spec.ts`
- `apps/web/e2e/composer-harness.html`
- `apps/web/e2e/composer-harness.tsx`
- `apps/web/e2e/run-all-e2e.mjs`
- `apps/web/playwright.composer.config.ts`
- `apps/web/playwright.config.ts`
- `apps/web/package.json`

## Privacy and security

- Draft records use a collision-free percent-encoded JSON tuple `[projectId, conversationId|null]` under the versioned `morrow.chat-draft.v2.*` same-origin `localStorage` namespace.
- Product requirement explicitly permits storing user-authored draft text. This means unsent text remains readable to the local browser profile and same-origin app code across reloads until sent or deleted; it is not encrypted storage.
- Records contain only `{ version, text }`. They never contain provider keys, tokens, provider/model routing data, workspace paths, or API response data.
- Malformed, unavailable, or unsupported-version storage fails to an empty draft without breaking the live editor. Storage write failures leave the live textarea authoritative.
- Accepted sends clear only their submitted scope. A late acceptance after navigation cannot clear the newly active conversation draft.

## Self-review

- The textarea has no `maxlength`, so over-limit text is never silently truncated. At 30,000 characters an accessible counter appears; above 32,000 it exposes `aria-invalid`, an alert, and a disabled send action.
- Autosize is bounded at 192px, then switches to internal scrolling. Mobile styles preserve 44px controls and safe-area bottom padding.
- Submit is guarded by an immediate ref as well as busy UI, preventing rapid Enter/button duplicates before React renders.
- Rejection and exceptions retain exact text and native selection where the browser permits, with an actionable live error. Busy state disables editing so an accepted request cannot erase text typed after dispatch.
- Autofocus is explicit through a prop, allowing Home/desktop to request it without forcing a mobile keyboard in every integration.
- Full conversation persistence/streaming, shell navigation, and searchable model catalogue were not added; those remain Tasks 5, 6, and 7 respectively.

## Commit

- `496d8ca feat(web): add resilient chat composer`
- `f5abff3 fix(web): harden chat composer lifecycle`
- `19604d4 fix(web): close chat composer review gaps`

## Concerns

- Task 4 deliberately provides the reusable production boundary; the new four-mode composer is not mounted into a conversation route because Task 5 owns that route and its dispatch lifecycle. Browser automation imports and exercises the production component directly through the isolated Vite test entry. Task 5 should mount `ChatComposer` without adding a controlled `value` or key-based remount.
- Synchronous `localStorage` writes happen on each input event to make immediate navigation/reload durable. The payload is bounded by the 32,000-character API contract; if future prompt limits grow substantially, persistence should move to a debounced write with a page-hide flush.
- Per `AGENTS.md`, the local draft-storage boundary requires review by someone other than its author before merge. This report is implementation evidence, not security approval.

## Review-fix pass — 2026-07-22

Commit `f5abff3 fix(web): harden chat composer lifecycle` resolves every Important and Minor item from the first independent review:

- Draft keys now use a v2 percent-encoded JSON tuple `[projectId, conversationId|null]`, eliminating delimiter, absent-versus-literal-`new`, and Unicode collisions. The ambiguous v1 namespace is not migrated into v2 because a collided v1 key cannot be attributed safely.
- The scope ref is updated only in a committed layout effect together with the textarea value. Events from the old committed DOM therefore save only to the old scope; aborted renders cannot redirect writes. A focused scope switch moves selection to the end of the newly loaded draft.
- Async send status, clearing, focus, and selection are owned by the submitted scope. Accepted stale sends clear only their submitted draft; stale rejection/exception UI is ignored. Accepted sends focus the empty enabled textarea; rejected/thrown sends restore exact retained text and the bounded prior selection after re-enable.
- Active-task state disables the textarea, modes, project, and route controls and blocks Enter plus form submission. Only an actionable Stop button remains. IME handling now guards React/native composition state and compatibility `keyCode`/`which` 229.
- Home mission success now receives the immutable mutation variables, clears only `submittedInput.projectId`, and does not clear or navigate away from a newly active project.
- Initial draft loading is a lazy state initializer, so ordinary rerenders do not read storage. Synchronous persistence remains bounded to the 32,000-character contract; direct Chromium verified exact 32,000-character insertion in under the five-second assertion, a separate rapid sequential sample without dropped characters, and held Backspace without corruption.

### Review-fix RED / GREEN evidence

- RED focused regression run: 7 expected failures across key collisions, IME 229, reject focus, stale accept/reject status, active-task submission, and late Home success.
- GREEN focused run: `pnpm.cmd --filter @morrow/web exec vitest run src/features/chat/draft-store.test.ts src/features/chat/chat-composer.test.tsx src/features/home/home-page.test.tsx --maxWorkers=1` — 3 files, 41 tests passed.
- Full web unit run: `pnpm.cmd --filter @morrow/web test -- --maxWorkers=1` — 15 files, 186 tests passed.
- Type check: `pnpm.cmd --filter @morrow/web check` — passed.
- Production build: `pnpm.cmd --filter @morrow/web build` — passed; the Vite-only harness HTML is not a production router route or production build input.
- Direct production-component Chromium: `pnpm.cmd --filter @morrow/web exec playwright test --config=playwright.composer.config.ts` — 5/5 passed in 9.4 seconds.
- `git diff --check` and cached diff check — passed.
- The Playwright-owned Vite harness used port 4381 and shut down cleanly; a final listener check confirmed port 4381 free.

### Direct browser coverage

The isolated `e2e/composer-harness.html` imports the production `ChatComposer` and exists only as a Vite test entry. It has no production route and contains no duplicate composer implementation. Chromium coverage includes native fast typing, held Backspace, selection, clipboard, undo/redo, multilingual/emoji text, exact 32,000-character input, autosize/internal scroll, collision-free scope switching and reload, selector-to-callback payloads, compositionend-followed-by-229, delayed accept/reject focus and selection, stale outcome suppression, active-task Enter/form blocking, and 390px safe-area-aware layout.

### Privacy and rollback

The same-origin local draft boundary remains intentionally limited to `{version: 2, text}` and contains no provider, credential, route, workspace, response, or task data. The namespace change fails closed rather than risk loading a v1 collision into the wrong project or conversation. The required independent security review remains outstanding; this author fix pass is not approval.

Executable rollback for both Task 4 commits, from this branch:

```powershell
git revert --no-commit 19604d4 f5abff3 496d8ca
git commit -m "revert: remove production chat composer"
```

No push was performed. This report, brief, review diffs, Playwright CLI session directory, and screenshots remain untracked controller evidence.

## Final review-fix cycle — 2026-07-22

Commit `19604d4 fix(web): close chat composer review gaps` closes the remaining review findings:

- Home now uses a committed-project ref updated in `useLayoutEffect` together with the controlled textarea DOM value. Submit and input handlers read that committed ref, never the render-time project prop. Transitioning to no project clears the committed owner and live control without deleting the prior project’s stored draft.
- The regression intentionally places a probe sibling before `MissionComposer`, dispatches an input event after project B renders but before the composer layout effect, snapshots both stores, and resolves project A’s pending response in the same layout-to-passive window. RED saved A’s event under B; GREEN saves it under committed A, then loads and preserves B. The late A success clears only A, caches the result, leaves B’s text intact, and does not navigate.
- The dedicated mobile project now carries real mobile/touch context rather than only resizing a desktop context. Its evidence includes `isMobile`, `hasTouch`, mobile UA, DPR, touch taps, a 44px minimum target, reduced-height reachability, internal scrolling, no horizontal overflow, and the exact safe-area declaration.
- `e2e/run-all-e2e.mjs` invokes both Playwright configurations through fixed Node argv with `shell: false`, records either failure, and always runs the dedicated composer suite even when the production suite fails. The package default `e2e` script calls this nonrecursive runner, so CI/default invocation cannot silently omit component coverage.

Final verification:

- Focused unit gate: 3 files, 42 tests passed.
- Full unit gate: 15 files, 187 tests passed.
- Type check and production build passed.
- Dedicated browser gate passed: 4 desktop Chromium tests plus 1 mobile Chromium test; 5 project-inapplicable cases skipped by design.
- Exact default `pnpm.cmd --filter @morrow/web e2e`: production suite 15 passed, 1 unrelated mobile result screenshot baseline failed, and 1 later dark-mode case did not run inside that production configuration. The runner still executed the dedicated composer suite afterward, where all 5 applicable tests passed. Expected baseline height was 2221px; stable actual was 2197px with roughly 3% pixel difference. Task 4 did not update or stage this unrelated snapshot.
- Final checks found no listener on harness ports 4373 or 4381.

Safe-area limitation: Windows headless Chromium computes the fallback branch of `max(var(--morrow-space-3), env(safe-area-inset-bottom))` and cannot emulate a physical nonzero notch inset. The test proves the exact production declaration, fallback padding, and layout behavior under a reduced mobile visual viewport; a nonzero hardware inset remains a physical-device integration check.
