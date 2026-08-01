# Morrow Redesign — Migration & Build Plan

> How the current interface becomes the chat-first product **without** losing the
> backend. Reviewed after the design gate is approved; implementation does not
> start until then. PR #64 stays open and unmerged throughout.

## 1. Principle: replace presentation, not the engine

The rejected UI is `apps/web`'s **presentation** (pages, mission composer, mission tabs, mission-first sidebar). Everything under `services/orchestrator` and `packages/contracts` is preserved. The chat, memory, cortex, mission, provider, and search capabilities already exist server-side (see `01-discovery.md`); the redesign surfaces them.

## 2. Old surface → new home

| Rejected element | Fate |
|---|---|
| Home = mission composer that navigates away | Home / Today: greeting + composer that **stays in a conversation** |
| Missions-first sidebar (Home·Missions·Connections·Settings + "Soon" previews) | Chat-first sidebar (Home·Chats·Projects·Missions·Library + Recent + Memory·Connections·Settings) |
| Standalone `/missions/$id` page with work/result/activity tabs | Compact mission card **in chat** + collapsible **mission detail panel** |
| Status-pill clusters, execution phases, raw enums | Humanized state words; detail behind "Show full activity" |
| Empty `ComingSoon` Library/Automations/Workspace | Library becomes real (artifacts); unfinished areas hidden or honestly "Early" |
| No chat / projects / memory UI | New Chat, Projects, Memory surfaces over existing `/api/*` |

**Reused as-is:** `api/client.ts`, `api/mission-stream.ts` (SSE), `api/{projects,providers}.ts`, `state/{runtime-status,theme}.tsx`, TanStack Router/Query wiring, a11y scaffolding, and the `tokens.css` palette (already on-brand).

## 3. Backend additions (small, additive, migration-safe)

1. **Web-projection routes** mirroring `web/mission-routes.ts`: `web/conversation-routes.ts`, `web/memory-routes.ts`, `web/project-routes.ts` — stable, secret-free read models for the browser. (Or the UI consumes existing `/api/*` directly for v1; projection is the clean target.)
2. **Chat streaming projection** — normalize `/api/tasks/:id/events/stream` into assistant-token events the chat UI consumes.
3. **Skills routes** — list/get/enable/disable over the existing `LearnedSkill` store (the one genuinely missing surface).
4. **Memory propose→confirm route** — for Journey 8 (suggestion → user confirms), on top of existing create/patch/delete.
5. **Provider-readiness gate on mission creation** — return the friendly "needs a model" state instead of letting a mission be born doomed.
6. **Cross-project personal profile** — reserved Personal space or surfaced `user_global` scope for "About you".

All additive; existing schemas/tables untouched; new tables via forward migrations; APIs backwards-compatible.

## 4. Build slices (each independently reviewable, TDD, committed + pushed)

1. **App shell & navigation** — new sidebar, routes, mobile tab bar, theme. (No behavior change to backend.)
2. **Conversation model surface** — list/create/open conversations; message list; persistence + refresh-preserves-state.
3. **Chat UI + streaming + modes** — composer, markdown, streaming, Ask/Plan/Build/Build-Auto → `SendMessage` mapping.
4. **Home / Today** — greeting, continue, active work, recent, suggestions, learned.
5. **Embedded mission progress** — mission card in chat + conversational events (reuse snapshot + SSE).
6. **Mission detail panel** — plan, status, verification, approvals, activity; retire the standalone page.
7. **Projects** — project view binding chats/missions/files/memory; project continuity.
8. **Memory UI** — About you / How you work / Lessons; edit/confirm/reject/enable/pin/delete; propose→confirm.
9. **Skills** — surface learned skills with controls (new routes).
10. **Library & artifacts** — real outputs from missions/files.
11. **Connections** — friendly provider setup, states, readiness gate.
12. **Accessibility & responsive** — WCAG AA, mobile polish, light/dark.
13. **Migration & compatibility** — remove rejected components; keep durable data.
14. **Packaging & `/app` serving** — production build served by orchestrator; installer intact.

## 5. Test gates (no vacuous, seed-only tests)

Per slice, plus these end-to-end in a **real browser** before "done":
- conversation without a mission; chat→mission escalation; the four modes;
- project context retrieval; memory confirm/edit/delete; **project isolation**; outcome learning influences later work;
- skill creation & reuse; provider readiness; in-chat mission progress; approval cards; recovery;
- result/artifact persistence to Library; responsive nav; a11y; light/dark; packaging; production `/app`; a real-provider consumer journey where credentials exist.

## 6. Sequencing vs. the gate

- **Now:** discovery ✓, spec ✓, journeys ✓, prototypes ✓ (this bundle). **Awaiting explicit visual approval.**
- **After approval:** finalize data models/APIs (Phase 4), then implement slices 1→14 (Phase 5), real acceptance (Phase 6), independent review (Phase 7).
- PR #64 is **not merged** until final approval.
