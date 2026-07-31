# Task 8 report — Missions inside chat (increment 1)

Base commit: `8c4e141`. Branch `feat/morrow-web-app-foundation` (PR #64, kept open/draft/unmerged).

## Delivered

A mission now appears inside the conversation it belongs to — a compact card plus a collapsible detail panel — built on the existing mission projection and snapshot. The conversation route stays stable.

## Implementation

- **Conversation↔mission link (web):**
  - `WebMissionSummary` gains `conversationId` (`z.string().min(1).nullable().default(null)`) — default keeps existing summaries valid. `projectMissionSummaryForWeb` populates it from `mission.conversationId`.
  - `CreateWebMissionSchema` gains an optional `conversationId`; the `POST /api/web/missions` route passes it to `missionService.create` (which already accepted `conversationId`).
- **`mission-card.tsx`** — compact card: humanized state tag (Working / Needs you / Done — verified / …), title, "N of M steps · phase", progress bar, and a "View details / Hide details" toggle (`aria-expanded`). An extra "Needs you" chip appears only when an otherwise-running mission has a pending attention item (the tag already covers needs_input/blocked).
- **`mission-panel.tsx`** — detail: Status / Step / Model, current work, a plan checklist (completed ✓ / running / pending / failed icons), verification summary + caveats, and recent activity.
- **Conversation wiring (`conversation-page.tsx`):** the `ConversationPage` wrapper fetches the project mission list and passes the mission whose `conversationId` matches this conversation down as `linkedMission`; the content renders the card + (on toggle) a detail child that fetches the snapshot. When no mission is linked it offers "Start a mission from this chat" (creates a mission with `conversationId` + the last user message as the objective, then refetches). All of this is gated by props the Slice 5 `ConversationPageContent` tests do not pass, so those tests are unaffected.
- **Styles** (`app.css`): mission card, state tags, progress bar, and the detail panel.

## Commands / results

- `pnpm --filter @morrow/contracts` vitest: **42 passed** (updated the one snapshot fixture for the new field).
- Orchestrator `web-mission-projection.test.ts` **17 passed** (added a focused test: the summary carries `conversationId`), `server-web-missions.test.ts` **28 passed**.
- Web `vitest`: **25 files, 195 tests passed** (adds mission-card + mission-panel; updated 3 typed `WebMissionSummary` fixtures for the new field).
- `tsc -p tsconfig.json` clean; `vite build` clean.
- Real-browser acceptance (Chromium, seeded projection): the mission card renders in the conversation ("Build the chat-first dashboard · 3 of 8 steps · Working"), and expanding it shows the plan checklist, verification, and recent activity, in light and dark. Screenshots in `docs/redesign/slice8-acceptance/`. Inspected manually.

## Pre-existing failures (NOT introduced here — proven)

The full orchestrator suite shows **20 failures in 3 unrelated files** (`provider-configure.test.ts` — HTTP 500 from real OpenRouter/DeepSeek auth calls with no network; `runner.test.ts`; `execution-continuity.test.ts` migration). Verified by `git stash`ing this slice's changes and re-running those files at the clean commit `8c4e141`: **identical 20 failures**. They are environmental/pre-existing and touch none of the files this slice changed.

## Known limitations / deferred

- In-chat plan proposal + Adjust before Start, a conversational mission event feed, and inline approval/recovery cards are the next increment. Approvals already exist via the attention projection and surface on the mission page / panel.
- The mission card refreshes on query refetch; live SSE-driven updates inside the card are a follow-on.
- "Start a mission from this chat" uses the last user message as the objective; a richer objective-capture flow is deferred.

## Rollback

`git revert <this commit>` removes the card/panel, the conversation wiring, and the `conversationId` projection/route/contract additions (the field defaults to null, so no data migration is involved).
