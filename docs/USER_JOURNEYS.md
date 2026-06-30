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
- `⛔` **If the service restarts between "queued" and "run", the task is orphaned
  forever** — see Journey: Restart.

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
1. `POST /api/tasks/:id/cancel` → `runner.cancel()` aborts the AbortController and
   flips queued/running → `cancelled` (`runner.ts:102`).
2. `/panic` stops all.
- `⛔` **No Windows process-tree kill:** `cancel()` only calls
  `controller.abort()`. A command that spawned child processes leaves **orphans**
  (no `taskkill /T`). (`command-executor.ts`, terminal/process category.)
- `⛔` **No subagent propagation:** cancelling a parent does **not** cancel its
  child tasks — they keep running (`runner.cancel` ignores `parent_task_id`).
- `⛔` **Cancel/complete race:** if the executor finishes as cancel runs, the
  `running→cancelled` transition may collide with a `verified` transition and
  throw `Invalid task transition` (→ 500). No deterministic synchronization.

## Journey: Restart (crash recovery)
1. On boot, `index.ts` calls `recoverRunningTasks(db)` → `running→interrupted`,
   interrupts streaming/queued messages, emits `task.recovery_required`.
- `⛔` **`queued` tasks are not re-dispatched.** The runner only runs a task when
  an API handler calls `runner.run()`. Nothing re-queues persisted `queued` tasks
  at startup → **a queued task created before the crash never runs.** This is the
  single most damaging task-truth gap. (`recovery.ts`, `index.ts`, `runner.ts`.)
- `⛔` **Subagent children inherit it** — a `queued` child orphaned, parent has no
  way to learn it never ran.
- `⛔` **`interrupted` agent tasks** can only be recovered by `retry` (fresh
  start) because `/resume` is broken for agents (see next).

## Journey: Resume
1. `POST /api/tasks/:id/resume`. For `inspect_workspace` (deterministic) it routes
   through `retryTask` → `queued` → runs cleanly (tested, `retry.test.ts`).
2. For `agent_chat`, it calls `resumeInterruptedTask` → `interrupted→running`,
   then `runner.run()`.
- `⛔` **Agent resume is a latent bug:** the executor then unconditionally calls
  `transitionTask("running")` (`agent.ts:271`); `running→running` is rejected by
  the state machine, so the task **fails on resume**. No test covers it.

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
3. Audit log + task events provide a trail.
- `⛔` **No single support-bundle export** (redacted logs + versions + task
  timeline in one artifact). A user diagnosing a stuck task must currently reason
  over raw events; there is **no tool-call timeline or subagent-tree view** in the
  UI (Phase 9).
- `⛔` **Stray debug logging** (`console.log("INSPECTING WORKSPACE PATH:" …)`,
  `inspect-workspace.ts:26`) leaks workspace paths to stdout.

---

## Dead-end summary (prioritized)

| # | Dead end | Journey | Severity | Fix slice |
|---|---|---|---|---|
| 1 | Queued task orphaned after restart | Restart | **P0 task-truth** | **slice 1 (this)** |
| 2 | Subagent child orphaned after restart | Restart | P0 | slice 1 |
| 3 | No process-tree kill on cancel (Windows) | Cancellation | P1 | slice 2 |
| 4 | Cancel doesn't propagate to subagents | Cancellation | P1 | slice 2 |
| 5 | Cancel/complete race → invalid transition 500 | Cancellation | P1 | slice 2 |
| 6 | Agent `/resume` `running→running` failure | Resume | P1 | slice 1/3 |
| 7 | Pending-approval-after-restart raw-SQL hack | Approval | P2 | slice 1/3 |
| 8 | No baseline-regression auto-block | Coding | P2 | Phase 4 |
| 9 | No support bundle / tool timeline | Diagnosis | P2 | Phase 9 |
| 10 | Stray workspace-path debug log | Diagnosis | P3 | quick fix |
| 11 | No continuous onboarding→first-task thread | Onboarding | P2 | Phase 2/5 |
