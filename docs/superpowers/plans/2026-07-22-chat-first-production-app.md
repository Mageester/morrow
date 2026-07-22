# Chat-first production application implementation plan

> **Execution:** Complete the tasks in order with test-first changes, browser inspection, diff review, a focused Conventional Commit, push, and ledger update after every slice. PR #64 stays open, draft, and unmerged.

**Goal:** Ship Morrow's approved chat-first product as the real packaged `/app`, with secure first-class OpenRouter, durable conversations, missions inside chat, and zero unexplained dead controls.

**Architecture:** Extend the existing contracts, Fastify orchestrator, SQLite repositories, provider registry, task SSE, mission projection, and React application. Provider secrets remain an orchestrator-only concern. The browser consumes typed status/catalogue/conversation projections and resumable event streams; it never receives credentials. The accepted redesign documents and prototype remain the visual reference.

**Stack:** TypeScript, Zod, Fastify, better-sqlite3, React 19, TanStack Router/Query, Vitest, Testing Library, Playwright.

## Non-negotiable invariants

- Never expose provider keys through response bodies, logs, SSE, errors, screenshots, tests, or Git.
- A provider becomes `connected` only after a successful authenticated request.
- One persisted assistant message per accepted submission; reconnect and replay must not duplicate it or tool execution.
- Ask/Plan remain conversations. Build/Build Auto may attach a mission without route replacement.
- Persist and display provider/model/mode truthfully; record intentional routing changes.
- Every rendered control works, is clearly disabled with an explanation, or is absent.
- All project-scoped mutations verify `projectId` ownership.
- No direct merge to `main`; final security-sensitive work requires independent review.

## Slice 1 — Clean baseline and PR metadata

**Files:**
- Modify: `packages/contracts/test/web.test.ts`
- Modify: `.superpowers/sdd/progress.md`

**Steps:**

1. Reproduce the stale `summary.modelLabel` fixture failure.
2. Add the required truthful fixture value only.
3. Run `pnpm.cmd --filter @morrow/contracts exec vitest run test/web.test.ts --maxWorkers=1` and `pnpm.cmd --filter @morrow/contracts test`.
4. Commit and push the isolated repair.
5. Rewrite PR #64 around the chat-first direction and return it to draft.

**Status:** Baseline repair committed/pushed as `630f23b`; PR confirmed open and draft.

## Slice 2 — OpenRouter provider backend

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `services/orchestrator/src/provider/connectivity.ts`
- Modify: `services/orchestrator/src/provider/openai-compatible.ts`
- Modify: `services/orchestrator/src/provider/registry.ts`
- Modify: `services/orchestrator/src/provider/secrets.ts`
- Modify: `services/orchestrator/src/repositories/provider-model-discovery.ts`
- Modify: `services/orchestrator/src/database.ts`
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/test/provider-connectivity.test.ts`
- Modify: `services/orchestrator/test/provider-configure.test.ts`
- Modify: `services/orchestrator/test/provider-model-discovery.test.ts`
- Modify: `services/orchestrator/test/providers.test.ts`
- Modify: `services/orchestrator/test/server-providers.test.ts`
- Modify: `services/orchestrator/test/database.test.ts`

**Steps:**

1. Add failing contract tests for author, modalities, tool/reasoning support, pricing, free/paid state, availability, and refresh time.
2. Add failing connectivity tests using realistic OpenRouter `/models` payloads, large responses, auth/rate/network failures, malformed records, and redaction assertions.
3. Normalize the catalogue without a handwritten source-of-truth list; persist health and freshness with a bounded TTL.
4. Make configure authenticate first and only persist/promote a key after success. Preserve the last known-good credential when replacement validation fails.
5. Implement an adequate Windows-local credential boundary using established project conventions; document compatibility and rollback. Never return secret values.
6. Add explicit manual refresh and stale-selection behavior.
7. Add streaming parser tests for fragmented text, assembled tool-call arguments, `[DONE]`, cancellation, malformed chunks, interrupted streams, and provider errors; implement the minimum parser changes.
8. Run focused provider suites, orchestrator check/build, secret-name/value scans, browser status inspection, then commit/push/update ledger.

## Slice 3 — Secure Connections workflow

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/providers.ts`
- Add: `apps/web/src/api/providers.test.ts`
- Modify: `apps/web/src/features/connections/connections-page.tsx`
- Add: `apps/web/src/features/connections/connections-page.test.tsx`
- Modify: `apps/web/src/styles/app.css`
- Add/modify: `apps/web/e2e/connections.spec.ts`

**Steps:**

1. Write failing tests for Connect, Save, Cancel, Test, connected, invalid key, rate limit, network error, disconnect confirmation, replace key, refresh, health time, model count, and default model.
2. Implement an OpenRouter-specific local password form. Never cache or echo the key after submission.
3. Keep failed replacement keys out of durable storage and keep the prior connection truthful.
4. Expose server-side credential wording and actionable failures.
5. Verify keyboard/focus/mobile behavior and that browser responses contain no key.
6. Run focused tests, web check/build, packaged browser inspection, then commit/push/update ledger.

## Slice 4 — Production chat composer

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

## Slice 5 — Conversation persistence and streaming

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

## Slice 6 — Chat-first shell and Home

**Files:**
- Modify: `apps/web/src/app/app-shell.tsx`
- Modify: `apps/web/src/app/app-shell.test.tsx`
- Modify: `apps/web/src/app/router.tsx`
- Modify: `apps/web/src/features/home/home-page.tsx`
- Modify: `apps/web/src/features/home/home-page.test.tsx`
- Add: `apps/web/src/features/chat/chats-page.tsx`
- Modify: `apps/web/src/state/theme.tsx`
- Modify: `apps/web/src/styles/app.css`
- Add/modify: `apps/web/e2e/navigation.spec.ts`

**Steps:**

1. Test New chat, Home, Chats, Projects, Missions, Library, Memory, Connections, Settings, recent chats, mobile navigation, and theme choices.
2. Build the narrow responsive shell and real recent-conversation navigation.
3. Populate Home from actual projects, conversations, active missions, and confirmed learning; no personal mock copy.
4. Add accessible keyboard navigation and light/dark/system persistence.
5. Inspect all viewport/theme states, then commit/push/update ledger.

## Slice 7 — Modes and model selection

**Files:**
- Modify: `services/orchestrator/src/routing/presets.ts`
- Modify: `services/orchestrator/src/routing/router.ts`
- Modify: `services/orchestrator/src/mission/task-dispatcher.ts`
- Modify: `services/orchestrator/test/routing.test.ts`
- Modify: `services/orchestrator/test/mission-task-dispatcher.test.ts`
- Add: `apps/web/src/features/chat/model-picker.tsx`
- Add: `apps/web/src/features/chat/model-picker.test.tsx`
- Modify: `apps/web/src/features/chat/chat-composer.tsx`

**Steps:**

1. Test Ask, Plan, Build, Build Auto across quick chat, persistent chat, mission dispatch, retry, and explicit model override.
2. Keep selected model stable per conversation/mission and persist intentional changes as routing evidence.
3. Implement searchable catalogue UI with availability, provider, context, modalities, capability, price/free state, stale status, and safe fallback when a saved model disappears.
4. Verify selection and keyboard behavior against live backend data, then commit/push/update ledger.

## Slice 8 — Missions inside chat

**Files:**
- Modify: `packages/contracts/src/web.ts`
- Modify: `services/orchestrator/src/web/mission-routes.ts`
- Modify: `services/orchestrator/src/web/mission-projection.ts`
- Modify: `services/orchestrator/test/server-web-missions.test.ts`
- Modify: `services/orchestrator/test/web-mission-projection.test.ts`
- Add: `apps/web/src/features/chat/mission-card.tsx`
- Add: `apps/web/src/features/chat/mission-card.test.tsx`
- Add: `apps/web/src/features/chat/mission-panel.tsx`
- Add: `apps/web/src/features/chat/mission-panel.test.tsx`
- Modify: `apps/web/src/features/chat/conversation-page.tsx`
- Add/modify: `apps/web/e2e/chat-mission.spec.ts`

**Steps:**

1. Test plan proposal, Adjust, Start mission, conversation attachment, one authoritative state, approvals, recovery, result, artifacts, and panel disclosures.
2. Keep the conversation route stable while Build modes create/attach a durable mission.
3. Show progress and concise conversational updates; preserve raw detail behind disclosure.
4. Prove approval/retry/stop actions and refresh/reconnect without duplicates.
5. Commit/push/update ledger after packaged browser acceptance.

## Slice 9 — Projects

**Files:**
- Modify: `services/orchestrator/src/repositories/projects.ts`
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/test/projects.test.ts`
- Modify: `apps/web/src/api/projects.ts`
- Add: `apps/web/src/features/projects/projects-page.tsx`
- Add: `apps/web/src/features/projects/project-page.tsx`
- Add: `apps/web/src/features/projects/projects-page.test.tsx`
- Modify: `apps/web/src/app/router.tsx`
- Add/modify: `apps/web/e2e/projects.spec.ts`

**Steps:**

1. Test list/detail and related chats, missions, files, memory, decisions, repositories, and artifacts with strict ownership.
2. Implement only data-backed surfaces; omit unsupported mutations.
3. Verify empty/error/mobile/keyboard states, then commit/push/update ledger.

## Slice 10 — Memory

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `services/orchestrator/src/repositories/memory.ts`
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/test/memory.test.ts`
- Add: `apps/web/src/api/memory.ts`
- Add: `apps/web/src/features/memory/memory-page.tsx`
- Add: `apps/web/src/features/memory/memory-page.test.tsx`
- Modify: `apps/web/src/app/router.tsx`
- Add/modify: `apps/web/e2e/memory.spec.ts`

**Steps:**

1. Test list/search/filter, provenance, confidence, scope, sensitivity, confirm/reject/edit/delete/pin/enable, proposed lifecycle, and project isolation.
2. Extend contracts/repository/routes with explicit lifecycle transitions and optimistic concurrency where needed.
3. Show applied-memory evidence in later conversation/mission work.
4. Verify destructive confirmation, keyboard/mobile states, then commit/push/update ledger.

## Slice 11 — Library

**Files:**
- Modify: `services/orchestrator/src/server.ts`
- Add: `services/orchestrator/test/library.test.ts`
- Add: `apps/web/src/api/library.ts`
- Modify: `apps/web/src/features/library/library-page.tsx`
- Add: `apps/web/src/features/library/library-page.test.tsx`
- Add/modify: `apps/web/e2e/library.spec.ts`

**Steps:**

1. Define a read-only projection over real persisted reports, documents, code artifacts, sites, uploads, research, and reusable skills.
2. Test project isolation and safe content/metadata boundaries.
3. Render only existing outputs and remove unsupported actions.
4. Prove mission results appear after persistence, then commit/push/update ledger.

## Slice 12 — Full interaction audit

**Files:**
- Maintain: `docs/redesign/06-production-interaction-inventory.md`
- Modify: all production route tests as inventory gaps demand

**Steps:**

1. Inventory every button, input, select, link, card, menu, modal, drawer, tab, toggle, checkbox, approval, retry, stop, memory, provider, project, and Library action.
2. Record route, behavior, API, keyboard, loading/success/empty/error/mobile states, automated test, and manual result.
3. Run an automated semantic-control scan and manual route sweep.
4. Fix every unexplained dead control; commit/push/update ledger only at zero.

## Slice 13 — Accessibility and mobile polish

**Files:**
- Modify: `apps/web/src/styles/app.css`
- Modify: `apps/web/e2e/accessibility.spec.ts`
- Modify: responsive visual specs/snapshots under `apps/web/e2e/`

**Steps:**

1. Test keyboard-only navigation, focus order/return, dialogs, live regions, screen-reader labels, contrast, zoom, reduced motion, mobile keyboard, touch targets, overflow, and safe-area layout.
2. Verify desktop/tablet/mobile in light/dark/system and compare production screenshots to accepted design references.
3. Record at least five fidelity comparisons and resolve Critical/Important defects.
4. Commit/push/update ledger.

## Slice 14 — Real-provider acceptance

**Files:**
- Add sanitized evidence under `.superpowers/sdd/` only; never store credentials or raw sensitive payloads
- Update: `.superpowers/sdd/progress.md`

**Steps:**

1. Detect only whether a local OpenRouter key exists; never print it.
2. If absent, stop at the secure local Connections form and request local entry without claiming connection.
3. If present, run the 24-step packaged `/app` journey, restart persistence, disconnect removal, and provider-missing interception.
4. Repeat essential flows across desktop/tablet/mobile, light/dark, and keyboard-only.
5. Sanitize evidence, verify no secret material, commit/push only safe evidence, update ledger.

## Slice 15 — Packaging and independent reviews

**Files:**
- Modify documentation and release packaging only where final evidence finds a gap
- Update: `README.md`, `docs/providers.md`, `docs/privacy-model.md`, `docs/ACCEPTANCE.md`, `.superpowers/sdd/progress.md`

**Steps:**

1. Run contracts/UI/web/orchestrator/CLI focused suites, repo checks/builds, Playwright, package build, installer, packaged `/app` smoke, and secret scan at the final committed SHA.
2. Obtain independent product, accessibility, security, race/reconnect, and code-quality reviews. The author does not self-approve security-sensitive work.
3. Fix every Critical and Important finding in focused tested commits.
4. Capture final desktop/tablet/mobile light/dark screenshots and compare against accepted design.
5. Report secure credential path, model discovery, real chat/composer evidence, interaction inventory, tests, screenshots, SHA, caveats, and honest readiness.
6. Leave PR #64 open, draft unless every gate and user readiness condition explicitly warrants otherwise, unmerged in all cases.

