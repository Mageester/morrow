# Morrow chat-first — Task 8 handoff

## What this is
Redesigning Morrow into a chat-first personal AI. Backend preserved; work is
frontend + thin projection. PR #64, branch `feat/morrow-web-app-foundation`,
**keep open/draft/unmerged, no destructive git**. Repo root:
`C:\Morrow\worktrees\morrow-web-app-foundation`.

## Running it
- Orchestrator (Fastify, better-sqlite3): port **4317**, `pnpm dev` (tsx watch) — runs in background.
- Web (React 19 + TanStack Router/Query + Vite): port **4318**, base `/app/` — background.
- Open: **http://localhost:4318/app/**  (vite proxies `/api` → 4317)
- Seed data: projectId `4777d47f-7436-4518-b70d-026cf1974af6` (Test).
  - Normal chat: `cd560069-6244-4f5a-9291-c227dba84ef6`
  - Chat with a linked mission in `needs_input`: `bb815734-d4e8-47ed-afee-45c4607e2550` (mission `mission-ad7aba89…`, "Waiting for you to approve the plan").
- **Provider: use opencode-zen** (host `opencode.ai`) — set it in the app's Settings/Connections (custom OpenAI-compatible → baseUrl opencode.ai; registry detects authMode `opencode-zen`). The free OpenRouter/DeepSeek endpoints are flaky here (upstream 400 / "stream ended before completion"). Do NOT enter credentials for the user — they set the key themselves.

## Done (committed + pushed, PR #64)
- `9695542` Slice 8-1: mission shown inside its conversation (card + panel, conversationId link).
- `9fd9a2b` **8-A layout root-cause**: nav grid grew to longest recent title (floating SOON / scrambled shell) → constrained nav grids to `minmax(0,1fr)` + `min-width:0` + clip sidebar; merged two conflicting `@media 760px` blocks into one drawer; "Message accepted." now transient. Verified 10 widths × light/dark, zero overflow/spill. Harness: `apps/web/scripts/layout-acceptance.mjs`.
- `c40e6c8` **8-B live SSE**: `ConversationMissionSurface` child subscribes `useMissionStream` + reads snapshot → card + panel live, Live/Reconnecting/Offline indicator, cursor-safe. Test `conversation-mission-live.test.tsx`.
- `43df3d4` **agent resume fix** (the "agents fail on commands" bug): mission agent tasks are dispatched `idle`; durable resume only advanced `interrupted`, so a first-turn tool call threw `Invalid agent state transition: idle -> executing_tool`. Fixed: on resume advance idle/interrupted → understanding → planning. Plus guard: late tool-completion after cancel is a no-op. Test `agent-resume-idle-toolcall.test.ts`.

Full web suite 197 pass, tsc + build clean.

## Remaining Task 8 (not done)
- **8-C** In-chat plan proposal card (objective, steps, success criteria, mode, model, permissions, limits) + **Adjust** + **Start**. Reuse the mission `awaiting_criteria_approval` state (already the "Waiting for you to approve the plan" projection). Replace the current "start from last message" with the confirmed-plan flow; keep a fallback that asks confirmation.
- **8-D** Inline **approve/deny/adjust/stop**, recovery cards, completion-as-result — all backend already exists: `POST /api/web/missions/:id/attention/:attentionId/resolve` (choiceId `approve`/`deny`/`retry`), `/retry`, `/stop`. Snapshot already carries `attention[]` (WebAttentionRequest) + `artifacts[]`. Reuse `features/missions/{attention-card,result-tab,mission-activity,mission-state}.tsx` inside the conversation.
- **8-E** Full browser journey acceptance (plan→adjust→start→progress→approval→failure→recovery→resume→result→refresh) + committed Playwright visual-regression (overflow/bbox assertions across the width matrix) + packaged `/app` smoke + app-wide visual sweep of every route.

## Key files
- `apps/web/src/features/chat/conversation-page.tsx` — `ConversationPageContent`, `ConversationMissionSurface` (live), `startMissionFromChat` (POST /api/web/missions, autonomy recommended).
- `apps/web/src/features/chat/{mission-card,mission-panel,chat-composer,model-picker}.tsx`.
- `apps/web/src/api/{mission-stream,query-keys,conversations,models}.ts`.
- `services/orchestrator/src/web/{mission-routes,mission-stream,mission-projection}.ts`.
- `services/orchestrator/src/execution/agent.ts` (state machine), `src/repositories/task-records.ts` (`allowedAgentStateTransitions`).

## Gotchas
- **SSE keeps the network open** → in Playwright use `waitUntil:"domcontentloaded"` + `waitForSelector`, never `networkidle` (times out).
- **Run vitest from `apps/web`** (jsdom is in its `vitest.config.ts`). From repo root / orchestrator you get "document is not defined". Session cwd is repo root — prefix `cd apps/web &&`.
- Playwright scripts must live under `apps/web/` and import `@playwright/test` (package `playwright` isn't installed).
- **~20 pre-existing orchestrator failures** (provider-configure network 500s, runner, execution-continuity migration) are baseline, NOT this work. A full-monorepo `vitest run` from the wrong cwd inflates failures because web tests then run without jsdom — ignore those.
- Backend already: create mission (autonomy `autonomous`→autoApprove), snapshot, retry, stop, attention/resolve, SSE stream. Don't build a second mission state machine.
- Contracts: `exactOptionalPropertyTypes` (optional props `?: T | undefined`); zod `.nullable().default(null)` needs explicit `null` in typed fixtures.
- No PAI modes / no voice ritual. (Caveman-mode terseness is a session hook, won't carry over.)

## Task ledger
`.superpowers/sdd/` — tasks 8-A..8-E tracked (A,B done). `progress.md`, `chat-first-task-8-*.md`.
Acceptance screenshots: `docs/redesign/slice8-acceptance/` (layout/, live-mission-card.png).

## First moves next session
1. Confirm servers up (`curl localhost:4318/app/` → 200) or restart both `pnpm dev`.
2. Set opencode-zen provider in Settings; send a Build message; confirm agents run tools (the resume crash is fixed).
3. Start **8-C**: plan card in chat off `awaiting_criteria_approval`, then 8-D inline approve using the existing resolve route.
