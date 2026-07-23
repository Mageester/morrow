# Task 5 — Conversation persistence and streaming report

## Status

Implementation, the first independent-review corrections, and the final fail-closed re-review correction are complete locally on `feat/morrow-web-app-foundation`. The production conversation route, project-scoped API, canonical persistence/reconciliation, resumable browser stream, lifecycle controls, and desktop/mobile browser journey are green. No push or merge was performed while this report was prepared. All review findings were addressed with regression coverage, and the final independent verdict is APPROVED with zero Critical, Important, or Minor findings.

The task brief, this report, prior review packages, Playwright CLI state, and existing screenshot evidence remain untracked and were not included in the implementation commit.

## Delivered behavior

- Added the production route `/app/chats/:conversationId?projectId=:projectId`, mounted inside the existing shell without changing Task 6 navigation.
- Mounted the Task 4 `ChatComposer` unchanged as the send boundary. Ask and Plan dispatch through the real conversation dispatcher/runner/agent path; accepted sends clear, rejected sends retain the draft.
- Added typed project-scoped create/list/get/messages/rename/archive/delete endpoints. Foreign-project resources return `404` without dispatching or mutating.
- Added explicit delete confirmation. Deletion rejects active queued/running responses with `409`, removes only the conversation and its FK-cascaded message/context/memory/tool-call dependents, and retains task records, the project, and unrelated conversations. The deletion boundary itself required no schema change; review follow-up migration 39 separately adds the request fingerprint described below.
- Added one client-generated idempotency key per user attempt. The same key survives the bounded transport retry; replay returns the same task and message pair with `200`; conflict returns `409`; only `200`/`202` acceptance clears the composer.
- Added canonical message history with truthful selected mode/provider/model, safe tool name/status/timestamps, retry for failed/interrupted responses, and exactly-once cancellation guarding.
- Added a project- and conversation-owned browser SSE endpoint with numeric resume cursor. It emits only coarse `task.updated`, `message.updated`, `tool.updated`, or `task.terminal` signals plus an opaque event ID. The UI re-fetches the persisted canonical message on signals, reconnect/open, and terminal boundaries; it never assembles assistant text from SSE deltas.
- Active queued/streaming messages resume after refresh. Cursor persistence, event-ID de-duplication, terminal close, offline/reconnecting copy, and canonical invalidation are covered independently.
- Rename, archive/restore, and confirmed deletion have deterministic dialog focus entry and return. Background refetch failure preserves useful cached history and displays a non-blocking warning.
- The deterministic mock provider now returns its text response directly when tools are disabled, so Plan mode does not fail by attempting the mock's read tool. Agent/tool-enabled mock behavior is unchanged.

## Independent-review corrections

- Migration 39 persists a canonical SHA-256 fingerprint over content, conversation/mission/worktree/agent identity, mode, preset, provider, model, reasoning, memory, and approval policy. Reusing an idempotency key with any different execution-affecting field now returns a conflict.
- Replay fails closed with `IDEMPOTENCY_INCOMPLETE` when a legacy row has no canonical fingerprint, even if its task/message/state/routing bundle is otherwise complete. There is no partial-field legacy equivalence fallback.
- Task creation, both message rows, initial agent state/event, and routing decision are committed in one SQLite transaction. The runner starts only after commit, and replay refuses any legacy/incomplete bundle.
- The browser cursor is validated and scoped to project, conversation, and task in `sessionStorage`. It survives remount and reconnect, advances only for accepted events, and clears only after canonical terminal reconciliation. Explicit cancellation performs that canonical refetch before clearing.
- Retry responses expose the last cursor from the prior attempt. The browser resumes after that cursor, so preserved audit events cannot replay an old terminal signal into the fresh failed/interrupted attempt.
- Rename/archive/delete mutations now reconcile both active and archived conversation-list caches immediately.
- Rename and destructive confirmation dialogs trap forward/reverse Tab, support Escape, and restore focus to their trigger.
- The packaged browser seed now includes a conservatively preserved active task plus failed and interrupted retry fixtures; no external provider or network is used.

## Privacy and security boundary

- Every new browser route proves both project ownership and conversation/task linkage before reading, dispatching, cancelling, retrying, deleting, or streaming.
- Browser message projection excludes tool arguments/results, artifact content, commands, stdout/stderr, task-event payloads, route candidate diagnostics, and free-form internal routing reasons.
- The nested send response points `aggregateUrl` at the safe canonical conversation-messages endpoint, never the legacy raw task aggregate. Its `sseUrl` points only at the coarse browser stream.
- Existing legacy task/conversation endpoints remain intact for the CLI and existing consumers; they are not exposed through the new web response URLs.
- Browser SSE uses the event sequence only as a bounded cursor and exposes an opaque event row ID. It does not forward raw persisted event payloads or assistant deltas.
- Delete is deliberately blocked while a linked response is active. It does not silently cancel work or remove durable task evidence.

## TDD evidence

- Baseline before production edits: orchestrator idempotency/SSE suites 8/8; Task 4 composer 17/17.
- RED contracts: two tests failed because creation/deletion and coarse browser projection schemas did not exist.
- RED backend: five expected failures covered missing `201`, scoped ownership routes, replay, and safe resumable SSE.
- RED frontend: three suites failed because the production conversation API, stream hook, and page did not exist.
- Browser RED: desktop passed, while the Pixel 7 Plan flow produced the real canonical error `Provider attempted a tool call while tools are disabled`. The mock-only Plan correction made both browser cases green.
- Final re-review RED: a complete task/message/state/routing bundle with only its fingerprint nulled replayed an identical request. The fail-closed correction makes both identical and mode-changed attempts return `IDEMPOTENCY_INCOMPLETE` without invoking the runner.

## Final verification

Final fail-closed re-review verification on 2026-07-22:

- `pnpm --filter @morrow/contracts check` — passed.
- `pnpm --filter @morrow/contracts test -- --maxWorkers=1` — 5 files, 42 tests passed.
- `pnpm --filter @morrow/orchestrator check` — passed.
- `pnpm --filter @morrow/orchestrator exec vitest run test/mission-task-dispatcher.test.ts test/database.test.ts test/database-migration-29.test.ts test/contracts.test.ts --maxWorkers=1` — 4 files, 34 tests passed.
- Dispatcher RED before the implementation change — 1 expected failure: the identical complete legacy bundle returned no error.
- Dispatcher GREEN after the implementation change — 1 file, 8 tests passed.

Earlier review-fix evidence follows.

Review-fix verification on 2026-07-22:

- `pnpm --filter @morrow/contracts check` — passed.
- `pnpm --filter @morrow/contracts test -- --maxWorkers=1` — 5 files, 42 tests passed.
- `pnpm --filter @morrow/orchestrator check` — passed.
- `pnpm --filter @morrow/orchestrator exec vitest run test/mission-task-dispatcher.test.ts test/database.test.ts test/database-migration-29.test.ts test/conversations.test.ts --maxWorkers=1` — 4 files, 28 tests passed.
- `pnpm --filter @morrow/orchestrator exec vitest run test/contracts.test.ts --maxWorkers=1` — 1 file, 10 tests passed.
- `pnpm --filter @morrow/web check` — passed.
- `pnpm --filter @morrow/web exec vitest run src/api/chat-stream.test.ts src/features/chat/conversation-page.test.tsx --maxWorkers=1` — 2 files, 9 tests passed.
- `pnpm --filter @morrow/web build` — passed; Vite transformed 2,024 modules and emitted the production bundle.
- `node node_modules/@playwright/test/cli.js test e2e/conversations.spec.ts` from `apps/web` — 4/4 passed: single assistant/tool execution and refresh durability; active refresh/offline reconnect from cursor plus cancellation; failed and interrupted retry from the prior-attempt cursor; Pixel 7 Plan plus rename/archive/delete and destructive-dialog focus proof.
- `git diff --check` — passed before final commit preparation.

The first broad browser attempt served the pre-change 16:04 web bundle and therefore failed the cursor assertion; after the required production rebuild, cursor persistence passed. The broad run also exposed unrelated existing mobile mission visual-baseline drift (3%); no snapshot was updated because it is outside Task 5. The focused packaged Task 5 browser suite is green.

Original implementation verification:

- `pnpm --filter @morrow/contracts check` — passed.
- `pnpm --filter @morrow/contracts exec vitest run test/contracts.test.ts --maxWorkers=1` — 1 file, 14 tests passed.
- `pnpm --filter @morrow/orchestrator check` — passed.
- `pnpm --filter @morrow/orchestrator exec vitest run test/conversations.test.ts test/idempotency-api.test.ts test/sse.test.ts --maxWorkers=1` — 3 files, 14 tests passed.
- `pnpm --filter @morrow/orchestrator exec vitest run test/plan-mode.test.ts test/conversations.test.ts test/idempotency-api.test.ts test/sse.test.ts --maxWorkers=1` — 4 files, 16 tests passed after the Plan correction.
- `pnpm --filter @morrow/web check` — passed.
- `pnpm --filter @morrow/web exec vitest run src/api/conversations.test.ts src/api/chat-stream.test.ts src/features/chat/conversation-page.test.tsx src/features/chat/chat-composer.test.tsx --maxWorkers=1` — 4 files, 26 tests passed.
- `pnpm --filter @morrow/web build` — passed; Vite transformed 2,024 modules and emitted the production bundle.
- `pnpm --filter @morrow/web exec playwright test e2e/conversations.spec.ts --project=desktop-chromium` — 2/2 passed: desktop Chromium Ask keyboard send and Pixel 7 touch Plan send, both with canonical terminal content, truthful route labels, no duplicate assistant row, refresh durability, and mobile no-horizontal-overflow proof.
- `git diff --check` — passed.

The shell printed existing PowerShell profile warnings about PSReadLine under redirected output and a Playwright global-setup Node warning about the repository's pre-existing `shell: true`; commands still exited successfully. The recurring pnpm `Command "vitest/playwright" not found` footer only appears when the invoked child test fails and was absent from final green runs.

## Files in the implementation commit

- `packages/contracts/src/index.ts`
- `packages/contracts/test/contracts.test.ts`
- `services/orchestrator/src/repositories/conversations.ts`
- `services/orchestrator/src/server.ts`
- `services/orchestrator/src/execution/agent.ts`
- `services/orchestrator/test/conversations.test.ts`
- `services/orchestrator/test/idempotency-api.test.ts`
- `services/orchestrator/test/sse.test.ts`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/conversations.ts`
- `apps/web/src/api/conversations.test.ts`
- `apps/web/src/api/chat-stream.ts`
- `apps/web/src/api/chat-stream.test.ts`
- `apps/web/src/features/chat/conversation-page.tsx`
- `apps/web/src/features/chat/conversation-page.test.tsx`
- `apps/web/src/app/router.tsx`
- `apps/web/src/app/app-shell.tsx`
- `apps/web/src/styles/app.css`
- `apps/web/e2e/conversations.spec.ts`

## Commit and rollback

- `e70d11b feat(web): add durable conversation workspace`
- `6df434c fix(web): close conversation lifecycle review gaps`
- `d7217f2 fix(orchestrator): fail closed on legacy idempotency rows`

Executable rollback from this branch after review, newest first:

```powershell
git revert d7217f2
git revert 6df434c
git revert e70d11b
```

This removes the final fail-closed correction, then the first review corrections including additive nullable migration 39, then the original Task 5 contracts, routes, page, browser stream, and mock Plan adjustment.

## Known limitations and next boundary

- Task 5 intentionally does not add a global Chats sidebar/list or new-chat Home surface; Task 6 owns the adaptive shell and navigation entry. A caller must currently provide the verified `projectId` query parameter when opening the conversation route.
- Task 7 owns the searchable full model catalogue. Task 5 renders the real route control inherited from Task 4 and shows the selected route returned by the server.
- Attachments remain unavailable because the message contract has no attachment field.
- Raw CLI task-event and aggregate routes remain for backward compatibility. The new browser route never links to them, but a future API-wide hardening project may choose to split loopback client privileges more formally.
- Task 5 has independent security/quality approval. The branch remains draft and unmerged because later production-reset slices and the final release gate are still pending.
