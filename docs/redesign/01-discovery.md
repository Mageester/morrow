# Morrow Redesign — Phase 1: Discovery

> First-hand inspection of the repository at the point the frontend direction was
> rejected. Records what was **observed in the code**, the reusable backend vs the
> rejected presentation, and the gaps the redesign must close.

- **Repo:** `Mageester/morrow`
- **Worktree:** `C:\Morrow\worktrees\morrow-web-app-foundation`
- **Branch:** `feat/morrow-web-app-foundation` (PR #64, open, **must stay unmerged**)
- **Head at inspection:** `01cd31e` — *docs(sdd): record mission-execution recovery + workspace redesign*
- **Working tree:** dirty. Modified: `apps/web/src/features/home/{home-page.test.tsx,mission-composer.tsx}`, `apps/web/src/styles/app.css`. Untracked: `apps/web/e2e/_shot.mjs`, a stray `*.mid` file at root. **Left untouched** — no destructive git used.

## 1. Repository shape

pnpm workspaces + Turbo monorepo. Node ≥ 22, pnpm 10.12.1. Product version `0.1.0-beta.31`.

| Area | Path | Role | Verdict |
|---|---|---|---|
| Orchestrator | `services/orchestrator` | Mission engine, providers, cortex, persistence (SQLite) | **PRESERVE** |
| Contracts | `packages/contracts` | Shared Zod schemas / protocol types | **PRESERVE + EXTEND** |
| Web app | `apps/web` | React 19 + TanStack Router/Query UI | **REJECTED presentation; reuse API/client plumbing** |
| UI kit | `packages/ui` | 8 shared components (Surface, StatusPill, Timeline, …) | **REPLACE/EVOLVE** |
| CLI | `apps/cli` | `morrow` CLI + TUI | Out of scope (keep) |
| Landing | `apps/landing` | Marketing site | Out of scope |
| Desktop / config / runtime | `apps/desktop`, `packages/config`, `services/runtime` | README-only scaffolds | Placeholders |

## 2. Backend to preserve (the valuable work)

`services/orchestrator/src` is a real, durable mission engine. Confirmed by direct file inspection:

- **Mission lifecycle** — `mission/kernel.ts`, `mission/service.ts`, `mission/controller.ts`, `mission/controller-runner.ts`. Durable missions owned by a controller that is *woken* after create / attention resolution; nothing fabricates progress.
- **Truthful state** — `mission/runtime-state.ts`, `mission/guardian.ts`, `mission/completion.ts`, `mission/reviewer.ts`. Guardian is the single computed source of truth; completion is evidence-gated (`completed_verified` vs `completed_with_caveats`).
- **Plan / criteria approval** — `mission/criteria.ts`, `mission/contract-extractor.ts`; `awaiting_criteria_approval` state; approve/deny via routes.
- **Checkpoints & recovery** — `mission/checkpoints.ts`, `workspace/checkpoints.ts`, `recovery.ts`, `mission/worker-recovery.ts`. Retryable failures bounded to 3 automatic attempts; non-retryable 401/402/403 switch to a configured alternate or block.
- **Verification** — `mission/evidence-runner.ts`, `acceptance/*` (browser-site, cortex-learning, sustained-autonomy).
- **Providers & routing** — `provider/*` (anthropic, openai, codex, gemini, openai-compatible, mock; oauth + oauth-flow for Claude/Codex subscription sign-in; connectivity, fallback, rate-guard, secrets, credentials). `routing/*` (model-catalog, router, presets, model-budget, usage-snapshot).
- **Conversations / chat (already real, unused by the UI)** — `repositories/conversations.ts` (conversations + `conversation_messages` with `role`, `content`, `taskId` mission link, `streamingState`, provider/model, + `message_tool_calls`). REST already exists in `server.ts`: `GET/POST /api/projects/:id/conversations`, `GET/PATCH /api/conversations/:id`, `GET/POST /api/conversations/:id/messages`, `POST /api/conversations/:id/compact`, `POST /api/quick-chat`. `runner.ts` streams assistant tokens into the message row; `execution/agent.ts` + `task-dispatcher.ts` build turns from the conversation and recall memory. **`SendMessage`** already carries `mode` (`read-only`/`plan-only`/`agent`), `autoApprove`, `useMemory`, `preset`/`model`/`reasoning`, and `missionId` — the four product modes map straight onto it.
- **Memory — transparent, editable, project-isolated (already real, backend-only)** — `repositories/memory.ts` + `MemoryEntrySchema`. Scopes include `user`, `episodic`, `procedural`, `knowledge`, `user_global`, `mission`; types include `user_preference`, `communication_preference`, `safety_rule`, `successful_approach`/`failed_approach`; every entry has source (user/summary/cortex), evidence, lifecycle, pinned/enabled, confidence, **sensitivity** (public→secret), staleness, provenance task. "No vector store, no hidden capture", reads strictly isolated by project. Ranked auditable recall (`retrieveRelevant`). REST: `GET /api/conversations/:id/memory`, `PATCH`/`DELETE /api/memory/:id`. **FTS search** (`SearchResponse`) spans conversations/messages/tasks/memory, never cross-project.
- **Cortex — adaptive intelligence** — `cortex/service.ts`, `cortex/automatic-memory.ts`, `cortex/automatic-skills.ts`, `cortex/mapper.ts`, `cortex/impact.ts`, `cortex/fingerprint.ts`. Builds/refreshes project intelligence at mission creation; captures deterministic repo facts + evidence-backed mission learnings; injects ranked memory with no manual save/index. REST: `GET /api/projects/:id/{intelligence,architecture,conventions,decisions,learnings,risks,rules}`, `PATCH .../conventions/:id`, `POST/DELETE .../rules`.
- **Agents, presets, models** — per-project named `Agent`s with role + per-agent tool/skill permissions (`/api/agents/*`); routing `Preset`s (best-quality/balanced/fast/cheap/coding/research/private-local) with privacy classes; model catalog with reasoning-capability provenance (`/api/{models,presets,providers}`).
- **Security** — `security/local-guard.ts`, `security/denied-name-patterns.ts`, `browser/injection-guard.ts`, `workspace/path-boundary.ts`, tamper-evident hash-chained `audit/log.ts`, `mcp/trust.ts`. Provider secrets never leave the server.
- **Web transport** — `web/mission-routes.ts`, `web/mission-projection.ts`, `web/mission-stream.ts` (SSE), `web/static-app.ts` (serves the SPA at `/app`).

**Contracts already present:** `mission-state.ts`, `mission-runtime.ts`, `reasoning.ts`, `web.ts` (mission projection for UI), and a rich **`cortex.ts`**: `ProjectIntelligence` (architecture map, conventions, decisions, risks, relationships, **mission learnings**, **user rules**, uncertainties) and **`LearnedSkill`** (scope, semver `version`, `triggerConditions`, `steps`, `permissions`, `validationRequirements`, `provenance`, `state` candidate→validating→active→…, success/failure counts, confidence, rollback history). Every cortex item carries **sources + confidence + freshness** by design — a strong foundation for a transparent Memory UI.

## 3. Frontend that is rejected

`apps/web` is a competent but **mission-console** experience — exactly the "debug website / workflow monitor" the brief rejects.

- **Shell** (`app/app-shell.tsx`): narrow sidebar, but nav is **Home · Missions · Connections · Settings** + a "secondary" group of `Library / Automations / Workspace` tagged **"Soon"**. Brand subtitle "Personal workspace". Footer runtime status pill.
- **Router** (`app/router.tsx`): routes `/`, `/missions`, `/missions/$missionId`, `/library`, `/automations`, `/workspace`, `/connections`, `/settings`. Basepath `/app`. **No `/chat`, no `/projects`, no `/memory`.**
- **Home** (`features/home/home-page.tsx`): eyebrow "Your private agent" → `<h1>Home</h1>` → a **MissionComposer** (a `<textarea>` "What should Morrow accomplish?" + "Start mission" button + Advanced autonomy `<select>`), then "Needs your attention / Active missions / Recent results" mission-card lists. Submitting **navigates away** to `/missions/$id` — the isolated mission page the brief explicitly rejects.
- **Mission page** (`features/missions/*`): overview + `work-tab` / `result-tab` / `mission-activity` + `attention-card`. Status pills, phases, verification, artifacts — operational, not conversational.
- **Placeholders** (`features/placeholders/*`): `ComingSoonPage`, plus placeholder Settings/Connections. Honestly labelled, but they are empty product areas.

**Verdict:** the presentation layer (pages, composer, mission tabs, sidebar) is disposable. The **data plumbing is reusable**: `api/client.ts`, `api/mission-stream.ts` (SSE), `api/{projects,providers,attention}.ts`, `state/{runtime-status,mission-status,theme}.tsx`, TanStack Router/Query wiring, and the accessibility scaffolding (skip link, focus management, `aria-live` regions).

## 4. The real gap (much smaller than the rejected UI implies)

The backend is **not** mission-only. Conversations, streaming chat, transparent memory (with personal/working-preference/episodic/outcome tiers), FTS search, agents, presets, and conversation-linked missions all exist and are tested. The rejected UI simply never surfaced them — it wired Home straight to a mission composer. So the redesign is **overwhelmingly a frontend + a thin web-projection layer**, not a backend rebuild. Concretely, what must be *added*:

1. **The chat-first frontend itself** — new shell (Home/Today · Chat · Projects · Missions · Library · Memory · Connections · Settings), chat surface with streaming + markdown + modes, embedded mission cards, mission detail panel, Projects, Memory, Library, Connections. Reuse `apps/web` plumbing (`api/client`, SSE, TanStack, theme, a11y).
2. **A web-projection layer** (mirror `web/mission-routes.ts` + `web.ts`) — read-model contracts/routes for conversations, memory, and projects so the browser gets stable, secret-free view shapes. The chat modes map to `SendMessage.mode` + `autoApprove` (Ask→`read-only`, Plan→`plan-only`, Build→`agent`+ask, Build Auto→`agent`+`autoApprove`).
3. **Chat→browser streaming** — assistant messages carry a `taskId`; `GET /api/tasks/:id/events/stream` (SSE) already emits token/turn events. The chat UI subscribes to that; a small `web/chat-stream` projection can normalize it.
4. **Skills web surface** — `LearnedSkill` exists in contracts + `automatic-skills.ts` but has **no HTTP routes and no UI**. Add read/list/enable/disable routes + a Skills view (under Memory or Library).
5. **Memory "propose → confirm"** — `CreateMemoryEntrySchema` + `automatic-memory` exist, but there is no *user-facing* suggestion→confirm endpoint for Journey 8. Add a small propose/confirm route; edit/enable/pin/delete already exist.
6. **Cross-project personal profile** — memory is project-isolated (correct for project memory) and the `user_global` scope exists, but there is no cross-project "About You" home. Decide: a reserved personal project vs. a global-scope store surfaced in Memory → "About you".
7. **Projects as first-class continuity** — `projects` repo + `/api/projects/*` exist and the old Home silently used `projects.data[0]`; there is no Projects UI binding chats + missions + memory + files per project.
8. **Chat-embedded missions** — reuse the existing mission snapshot + SSE, rendered as a compact in-chat card + collapsible detail panel, replacing the standalone mission page.

## 5. Reproducing the current experience

Dev servers: orchestrator (`:4317`) + web (`vite`, `:5173`), SPA also served at `/app` in packaged builds. E2E (Playwright) seeds mission state (`e2e/seed-state.ts`) and captures visual snapshots at desktop/tablet/mobile — useful harness to inherit, but per the brief, **screenshots of seeded state are not acceptance**; real browser journeys are.

## 6. Constraints carried into design

- Preserve every functional backend fix; extend contracts with **migrations + backwards-compatible APIs**; do not collapse new concepts into the mission aggregate.
- Secrets never reach the browser; memory is user-visible/removable; project memory cannot leak across projects; Build Auto does not bypass permission boundaries.
- No page may ship as a fake placeholder pretending to be finished. Incomplete → hidden or honestly marked.
- Design gate: prototypes + screenshots + explicit visual approval **before** production frontend work. PR #64 stays open.
