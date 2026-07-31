## Task 5 — Conversation persistence and streaming

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `services/orchestrator/src/repositories/conversations.ts`
- Modify: `services/orchestrator/src/server.ts`
- Add/modify: `services/orchestrator/test/conversations.test.ts`
- Modify: `services/orchestrator/test/idempotency-api.test.ts`
- Modify: `services/orchestrator/test/sse.test.ts`
- Add: `apps/web/src/api/conversations.ts`
- Add: `apps/web/src/api/chat-stream.ts`
- Add: `apps/web/src/api/chat-stream.test.ts`
- Add: `apps/web/src/features/chat/conversation-page.tsx`
- Add: `apps/web/src/features/chat/conversation-page.test.tsx`
- Add/modify: `apps/web/e2e/conversations.spec.ts`

**Steps:**

1. Specify create/list/load/rename/archive/delete contracts and project ownership in failing tests.
2. Add durable delete/confirmation semantics and server routes without weakening archive behavior.
3. Project resumable task events into assistant message updates; re-fetch the canonical message at terminal/reconnect boundaries.
4. Prove accepted-only send, idempotent replay, refresh resume, cancellation, client disconnect, no duplicate assistant row, and no duplicate tool execution.
5. Implement history, titles, rename/archive/delete, tool summaries, and actionable retry.
6. Verify packaged refresh/reconnect in browser, then commit/push/update ledger.

