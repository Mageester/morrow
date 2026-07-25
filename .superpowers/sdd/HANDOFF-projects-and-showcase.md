# Morrow — handoff: Projects/active-workspace + Nova Board dogfood build

## What this is
Two threads from one session, both live:
1. **Product work**: finished Part 1 of the P0 contract (Projects UI + centralized active-project state) on `feat/morrow-web-app-foundation` (PR #64, **still open/unmerged**).
2. **Dogfood proof**: used Morrow's own Build Auto chat (free model) to build a real full-stack app (`Nova Board`), verified it independently, packaged it, added a showcase page to the marketing site, wrote a PDF report.

Repo root: `C:\Morrow\worktrees\morrow-web-app-foundation`.

## ⚠️ Read before doing anything else
- **Redesign directive is on record and was explicitly overridden for this session.** Memory `morrow-redesign-directive` says the existing frontend is rejected and a mandatory design-gate (spec+prototypes+screenshots+explicit approval) is required before touching production frontend. The user was asked directly and said **"skip gate, implement now"** — that override applies to the Part 1 work below, not blanket-forever. If continuing frontend work in a fresh session, this hasn't been re-confirmed — worth a quick check-in rather than assuming the skip still stands.
- **Part 1 changes are uncommitted.** `git status` shows real, working, tested changes not yet committed (see below). Don't lose them.
- The original directive that kicked off this session had **Parts 2–4 cut off mid-message** (only Part 1 — Projects/active-workspace — ever arrived in full). Whoever gave the directive said they'd resend the rest "separately later" — they never did in this session. Ask for them.

## Part 1 — DONE, uncommitted

Removed the `projects[0]` / `projects.data?.[0]` accidental-default pattern. Full P0 requirements (Projects route, add-project flow, central active-project state) were already mostly built by a prior session — this session's actual work was narrower than the original ask implied:

- **`use-active-project.ts`**: no more silent fallback to an arbitrary project. Sole-project case still auto-resolves (unambiguous). Multi-project with no selection, or any stale/deleted selection, now surfaces `needsSelection`/`staleSelection` instead of guessing — verified live in browser that a corrupted `localStorage` selection shows an honest recovery card, not a silent swap to one of the other 3 real registered projects.
- **Home / Missions / Chats pages**: updated empty states to distinguish "no projects yet" vs "pick one" vs "your selection is stale", each linking back to `/projects`.
- **Projects page**: added the local-only/no-upload copy on the add-project form, and an "Open {project} in Build" link when a project is active.
- Fixed test isolation bug this surfaced (localStorage leaking between tests in `projects-page.test.tsx`).

**Verified**: 208/208 web tests pass (was 206 baseline). Live-browser-verified against the real orchestrator (4 real registered projects: Test, morrow, Todo App fixture, Fullstack Demo fixture, plus Nova Board added this session) — selection persists across reload, stale selection recovers honestly.

**Not committed yet** — `git status --short` in the worktree shows:
```
M apps/web/src/features/chat/chats-page.tsx
M apps/web/src/features/home/home-page.tsx
M apps/web/src/features/missions/missions-page.tsx
M apps/web/src/features/projects/projects-page.test.tsx
M apps/web/src/features/projects/projects-page.tsx
M apps/web/src/features/projects/use-active-project.test.tsx
M apps/web/src/features/projects/use-active-project.ts
M apps/web/src/styles/app.css
```
`vite.config.ts` and `services/orchestrator/src/index.ts` also show modified but were **not touched this session** — pre-existing uncommitted state from before, left alone. Investigate before committing anything broad (don't `git add -A` blind).

## Part 1 — NOT done (original P0 contract, still open)
- Task 2: background dev processes integrated into mission state/evidence.
- Task 8 remaining slices (8-E full journey acceptance) — see the older `HANDOFF-task8.md` in this same directory for detail, still accurate as of this session.
- Whatever Parts 2–4 of the cut-off directive were going to specify.

## Running it (product work)
- Orchestrator: port **4317**, was already running from a prior session when this one started — still up, don't restart blindly, check `curl 127.0.0.1:4317/api/projects` first.
- Web (Vite): was run on **4319** this session (4318 was occupied) — **currently stopped**, restart with `pnpm --filter @morrow/web dev` from the worktree root.
- Registered projects include real ones (`morrow`, `Todo App (fixture)`, `Fullstack Demo (fixture)`) plus **`Nova Board`** (new, see below) — `Nova Board`'s workspace path is `C:\Users\aidan\Documents\Morrow Test Repos\nova-board`.
- `.claude/launch.json` at `C:\Morrow\.claude\launch.json` (repo-root level, not worktree) has `morrow-web` and `axiom-site-preview` preview configs for the Browser tool's `preview_start`.

---

## Dogfood build — Nova Board

Used the actual product (not hand-written code) to prove the P0 contract end to end: registered a fresh project, started a Build Auto conversation, picked a **free** model, let it build autonomously, then independently verified everything rather than trusting the agent's own "done" claim.

- **Project**: registered as `Nova Board`, path `C:\Users\aidan\Documents\Morrow Test Repos\nova-board`. Real git repo, 2 commits (`init`, then the actual build).
- **Model used**: `deepseek-v4-flash-free` via provider `openai-compatible` (opencode-zen gateway, host `opencode.ai`) — already configured/available server-side (env-based, not through the Connections UI, which currently only surfaces OpenRouter — a gap worth fixing separately).
- **What it built**: Express + SQLite (`better-sqlite3`, WAL) + `ws` WebSocket backend, vanilla-JS frontend, full CRUD + move/reorder REST API, live `board:updated` + `users:count` broadcast, seeded starter board.
- **Verification performed** (all real, not re-reading the agent's own claims — its first "fully operational" message was already stale by the time it was checked, server had been stopped):
  - Files on disk confirmed non-trivial.
  - Fresh-DB server start confirmed via logs.
  - REST API hit live, WebSocket broadcast confirmed with a real second client via a raw `ws` test script.
  - Browser-rendered, zero console errors.
  - **Independent from-scratch install**: `git archive` → clean dir → `npm install` (no reused `node_modules`) → fresh DB → server start → full test suite. Identical pass result.
- **Test suite**: wrote a real 9-test suite (`test/api.test.js`, `node --test`) covering REST CRUD, validation 400s, 404 handling, both WebSocket event types, static frontend serving. **9/9 passing**, run twice (working copy + from-scratch install).
- **Free-model routing smoke test**: sent the same read-only question to 5 free opencode-zen models. 3/5 (`deepseek-v4-flash-free`, `mimo-v2.5-free`, `nemotron-3-ultra-free`) succeeded; 2/5 (`north-mini-code-free`, `laguna-s-2.1-free`) failed with real, honestly-surfaced provider errors (upstream failure, rate limit) — not hidden, not silently retried onto a different model.
- **Packaging**: `nova-board-v1.0.0.zip` (~28KB, source-only, git-archive export) at `C:\Users\aidan\Documents\Morrow Test Repos\nova-board-release\`. Delivered to the user. **Not published to GitHub** — user confirmed local-only is fine, no remote exists for this repo.
- **Report**: `Nova-Board-Report.pdf` at `C:\Users\aidan\Documents\Morrow Test Repos\Nova-Board-Report.pdf`. Delivered to the user. Documents the ask, what was built, independent verification steps, test results, the free-model routing results (including the 2 failures), packaging, and honest limitations (drag-and-drop verified via its underlying API calls, not a recorded live mouse-drag; no auth on the API).
- **Server state**: Nova Board's own server was restarted clean at the end of the session and is **currently running on port 3000** (`node server.js` from `C:\Users\aidan\Documents\Morrow Test Repos\nova-board`). If it's down, `npm start` from that directory brings it back (auto-seeds if the DB is empty).

## Website — morrow-axiom-site
- Added `src/pages/showcase.astro` presenting the Nova Board build as proof-of-capability, using the **same real numbers** as the PDF (including the 2 failed free-model runs — not cherry-picked).
- `astro check`: 0 errors. `astro build`: succeeded. Browser-verified via local `astro preview` (port 4321): correct render, zero console errors.
- **Committed locally only** (`4e413c2`) — repo has a real GitHub remote (`Mageester/morrow-axiom-site`) — **not pushed**. User has not been asked to push; do not push without asking, this is a real public-facing site.
- Preview server currently stopped. To re-check: `pnpm --dir morrow-axiom-site preview --port 4321` (or via `.claude/launch.json`'s `axiom-site-preview` config), then browse `/showcase`.

## Key gotchas learned this session
- **`node.exe` on Windows doesn't understand git-bash's `/tmp`** — it resolves to `C:\tmp` literally and fails. Use the scratchpad dir (absolute Windows-style path) for any file the Bash tool writes and Node needs to read back.
- **`.claude/launch.json` for the Browser tool's `preview_start` must live at the *primary working directory* root** (`C:\Morrow\.claude\launch.json`), not inside a worktree — and `runtimeArgs` need `pnpm --filter <pkg> dev`-style invocation since there's no root `package.json` at `C:\Morrow` itself.
- **PowerShell + bash quoting**: `Stop-Process -Id $(...)` inline breaks when bash expands `$_`/`$p` oddly — assign to a PowerShell variable first (`$p = Get-NetTCPConnection ...; Stop-Process -Id $p`), don't inline-pipe into `Stop-Process` from a bash heredoc.
- **Don't trust an agent's own completion claim** — Nova Board's first "fully operational" message in-chat was already false (server stopped) by the time it was independently checked. Always re-verify directly outside the chat transcript.
- Free opencode-zen models genuinely fail sometimes (`hy3-free` isn't even a supported model — hard error; `north-mini-code-free` and `laguna-s-2.1-free` failed with real upstream/rate-limit errors in the smoke test). This is expected free-tier behavior, not a Morrow bug — but worth setting expectations with the user.

## First moves next session
1. Confirm what's still running: orchestrator (4317), Nova Board (3000). Restart web dev server (4319) if continuing product work.
2. **Commit Part 1's uncommitted changes** (review the diff first, don't blind `git add -A` — two unrelated pre-existing modified files sit alongside them).
3. Ask for Parts 2–4 of the original directive (background-process-in-mission-state, Task 8 remainder, full-stack-outside-scratch-folder verification) — never fully received.
4. If asked to push the `morrow-axiom-site` showcase commit or cut a GitHub release for Nova Board, that's new explicit permission to get — wasn't granted this session beyond "local zip is fine."
