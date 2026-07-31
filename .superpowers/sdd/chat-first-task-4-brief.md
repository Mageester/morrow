## Task 4 — Production chat composer

**Files:**
- Add: `apps/web/src/features/chat/chat-composer.tsx`
- Add: `apps/web/src/features/chat/chat-composer.test.tsx`
- Add: `apps/web/src/features/chat/draft-store.ts`
- Add: `apps/web/src/features/chat/draft-store.test.ts`
- Modify: `apps/web/src/styles/app.css`
- Add/modify: `apps/web/e2e/composer.spec.ts`

**Steps:**

1. Write failing tests for focus, selection/cursor stability, fast typing, editing keys, clipboard events, undo/redo, multiline paste, URLs/code/emoji, IME composition, Enter/Shift+Enter, long prompts, resize cap, accepted-only clearing, no double-send, disabled/error recovery, and draft restore.
2. Implement a stable textarea boundary whose streaming parent updates do not replace selection or DOM identity.
3. Persist drafts per conversation/project in local UI storage only; clear only after accepted submission.
4. Wire real mode/model/project controls. Remove attachment UI until a backend contract exists.
5. Add stop-generation behavior only when a live task exists.
6. Run unit/browser keyboard/mobile checks, then commit/push/update ledger.

