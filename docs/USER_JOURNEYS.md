# Morrow — Real User Journeys

> What a user **actually** experiences today, traced through real CLI commands,
> HTTP routes, and UI components — not the intended design. Every dead end,
> hidden prerequisite, and undocumented step is called out. Paired with
> `docs/HERMES_LEVEL_PLAN.md` (category scores).
>
> Captured 2026-06-30 on branch `hardening/runtime-reconciliation`. Evidence is
> cited by file/route. `⛔` marks a dead end / trust gap.

## Surfaces

- **CLI / TUI:** `apps/cli` → `morrow <command>` + interactive terminal
  (`src/terminal/*`). Entry `src/main.ts`.
- **Web:** `apps/web` (React/Vite) → `App.tsx` routing to `MissionControl`,
  `OnboardingWizard`, `ProviderManager`, `SkillsControlCenter`, `SystemHealth`.
- **Backend:** `services/orchestrator` Fastify server, default `127.0.0.1:4317`.
  CLI/web are clients of its HTTP + SSE API.

---

## Journey: Fresh install
1. Download/run `installer/install.ps1` (Windows). Atomic, data-preserving swap;
   bundles Node runtime. → installs `morrow` launcher, sets PATH.
2. `morrow doctor` validates node/pnpm/home/migrations/providers.
- **Hidden prerequisite:** Windows-only today (`install.sh` for Linux is MISSING
  per parity matrix). macOS/Linux users have no one-command path.
- `⛔` **Health-failure rollback is untested** — if the freshly-activated service
  is unhealthy, the rollback exists but has no automated proof (`CURRENT_STATE.md`).

## Journey: Onboarding
1. CLI: `morrow onboard` (`commands/onboard.ts`) or web `OnboardingWizard`.
2. Sets `user.onboarded` / `onboardingStep` settings.
- `⛔` **No verified continuous thread** from onboarding → provider → workspace →
  first task. Each step works in isolation; the seam between them is unproven
  (Journey A in `HERMES_LEVEL_PLAN.md` Phase 2 will close this).

## Journey: Provider connection
1. CLI `morrow providers` / web `ProviderManager`.
2. API-key providers: store key → `POST /api/providers/:id/test` (connectivity).
3. Claude/Codex: OAuth/PKCE sign-in (`provider/oauth-flow.ts`). Gemini stays key-only.
- **Undocumented edge:** which providers support OAuth vs key is only obvious
  from code; the wizard doesn't explain the split clearly.
- `⛔` **No rate-guard** — a provider returning 429 has no backoff policy (matrix
  MISSING). Transient failures aren't cleanly distinguished from fatal (Journey E).

## Journey: First task
1. Select/create project (`projects` CLI / API) — needs a workspace path.
2. Create a conversation, send a message → `POST /api/conversations/:id/messages`
   creates an `agent_chat` task `status=queued`, then `runner.run(task.id)`
   (`server.ts:665`), streams via SSE (`/api/tasks/:id/events/stream`).
3. Watch tool cards, plan steps, final answer.
- **Hidden prerequisite:** a project with a valid workspace path must exist first.
- **Works:** startup reconciliation re-dispatches persisted `queued` tasks after
  restart; see Journey: Restart for the remaining recovery gaps.

## Journey: Mission Control
1. `morrow mission` opens the primary terminal Mission Control session. It is the
   same live task surface as chat/fix, with streaming events, approvals, Ctrl+C
   cancellation, mode/provider controls, `/output`, `/diff`, and `/undo`.
2. `/tree` renders the current mission's persisted task/subagent tree from
   `GET /api/tasks/:id/tree`.
3. `/result` renders the current mission aggregate: status, provider/model,
   mode/privacy, plan, files affected, command/tool evidence, verification,
   approvals, and the next safe action.
- **Works:** CLI formatter tests cover nested task trees and mission result
  summaries (`apps/cli/test/mission-control.test.ts`); root command parsing
  covers `morrow mission` (`apps/cli/test/main.test.ts`).
- `⛔` **Remaining gap:** `/result` is a compact evidence summary, not a full
  chronological tool timeline or parent synthesis view. Web MissionControl is
  still not the primary live mission cockpit.

## Journey: Coding task
1. As First task, but the agent uses `read_file`/`inspect_workspace`/`grep`/git
   tools and `propose_patch` (gated by approval) to change files.
2. `/diff` (`GET /api/tasks/:id/diff`) shows the change; `/undo`
   (`/api/tasks/:id/undo`) rolls it back.
- **Works:** repair e2e is tested (`agent-repair-e2e.test.ts`).
- `⛔` **No baseline-regression auto-block:** `compareBaseline` exists
  (`workspace/diagnostics.ts`) but is **not wired into the write path**, so an
  edit that adds type/lint errors is not automatically caught before "completed".
- `⛔` **Verification gating is shallow** — a task can reach `completed` without a
  hard re-verify step, risking a confidently-wrong success (Phase 4).

## Journey: Approval
1. Agent proposes a command/patch → approval record `pending`
   (`repositories/approvals.ts`), task waits (agent state `waiting_for_approval`).
2. User approves/denies → `POST /api/approvals/:id` → continuation resumes the
   saved tool call (`task-continuations.ts`).
- **Safety (good):** categorically-dangerous actions are blocked **before** an
  approval is even created (`command-policy.ts`); YOLO can't bypass.
- `⛔` **Pending-approval across restart is fragile:** recovery interrupts the
  task; resolving the approval then uses a **raw-SQL `interrupted→queued` hack**
  (`server.ts:888`) that bypasses the state machine — separate from `/resume`,
  easy to break.

## Journey: Cancellation
1. `POST /api/tasks/:id/cancel` -> `runner.cancel()` aborts the AbortController,
   propagates cancellation to persisted descendants, and flips queued/running
   work to `cancelled` (`runner.ts`).
2. `/panic` stops all.
- **Works:** Duplicate cancellation is idempotent (`already_cancelled`), already
  terminal tasks return a structured `409` instead of an internal error, and a
  late approval cannot revive cancelled work.
- **Works on Windows:** command cancellation exercises structured
  `taskkill /F /T /PID` and is verified with a parent/child/grandchild process
  tree plus an unrelated survivor process (`command-executor.test.ts`).
- `⛔` **Remaining gap:** cancel-across-restart and interface-level messaging need
  a user-visible acceptance path, not just backend truth.

## Journey: Restart (crash recovery)
1. On boot, `index.ts` calls `recoverRunningTasks(db)` → `running→interrupted`,
   interrupts streaming/queued messages, emits `task.recovery_required`.
2. Startup reconciliation re-dispatches orphaned `queued` tasks, clears partial
   pre-running artifacts, and cancels queued children whose parent is already
   terminal.
- **Works:** recovery tests cover idempotent queued-task re-dispatch, subagent
  child re-dispatch under a recovered parent, terminal-parent cancellation, and
  a restart acceptance where a queued deterministic task reaches `verified`.
- `⛔` **Remaining gap:** mid-stream reconnect/dedup and cancel-across-restart
  interface acceptance still need user-visible proof.

## Journey: Resume
1. `POST /api/tasks/:id/resume`. For `inspect_workspace` (deterministic) it routes
   through `retryTask` → `queued` → runs cleanly (tested, `retry.test.ts`).
2. For `agent_chat`, it calls `resumeInterruptedTask` -> `interrupted` to
   `running`, then `runner.run()`. The agent executor is state-aware and does
   not attempt a duplicate `running -> running` transition.
- **Works:** `cancellation-lifecycle.test.ts` covers interrupted agent resume so
  it does not fail with an invalid lifecycle transition.

## Journey: Update
1. `morrow update` → `checkForUpdate` (`service/update.ts`) compares SemVer
   (pre-release aware) against a fetched latest version.
- **Works:** detection + version drift guard (ADR-0005, CI-enforced).
- `⛔` **Apply-update automation is partial** — actually pulling+reinstalling the
  new version (and rolling back on failure) is not a documented, tested one-command
  flow for the packaged build.

## Journey: Failure diagnosis
1. `morrow doctor` reports environment/service/provider/migration health.
2. `/api/projects/:id/diagnostics` returns normalized tsc/eslint diagnostics.
3. Audit log + task events provide a trail. In terminal Mission Control, `/tree`
   shows the task/subagent tree and `/result` summarizes final evidence.
- `⛔` **No single support-bundle export** (redacted logs + versions + task
  timeline in one artifact). A user diagnosing a stuck task still lacks a full
  chronological tool-call timeline and parent synthesis view (Phase 9).
- `⛔` **Stray debug logging** (`console.log("INSPECTING WORKSPACE PATH:" …)`,
  `inspect-workspace.ts:26`) leaks workspace paths to stdout.

---

## Dead-end summary (prioritized)

| # | Dead end | Journey | Severity | Fix slice |
|---|---|---|---|---|
| 1 | Cancel/restart continuity needs interface-level acceptance | Cancellation | P1 | slice 2 |
| 2 | Mid-stream reconnect/dedup after service recovery | Restart | P1 | slice 2 |
| 3 | Approval-after-restart path still uses direct status reset | Approval | P2 | slice 3 |
| 4 | Full tool timeline and parent synthesis view | Diagnosis | P2 | Mission Control |
| 5 | Terminal/duplicate cancellation route semantics need richer CLI/web wording | Cancellation | P2 | Mission Control |
| 6 | No baseline-regression auto-block | Coding | P2 | Phase 4 |
| 7 | No support bundle / tool timeline | Diagnosis | P2 | Phase 9 |
| 8 | Stray workspace-path debug log | Diagnosis | P3 | quick fix |
| 9 | No continuous onboarding→first-task thread | Onboarding | P2 | Phase 2/5 |
