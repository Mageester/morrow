# Morrow — Hermes-Level Product Maturity Plan

> Evidence-based maturity assessment. Scores are **not generous**. A category
> scores **5 only when verified end-to-end user behavior exists** (real backend +
> reachable UI + automated proof). This document is the program map; the work it
> motivates lands as focused vertical slices, not as documentation alone.
>
> - **Assessor:** automated engineering pass, session of 2026-06-30.
> - **Base:** branch `hardening/post-pr18` (PR #19 not yet merged into `main`; the
>   installer-recovery + deterministic-resume fixes are present on this branch).
>   Working slice branch: `hardening/runtime-reconciliation`.
> - **Toolchain:** Node v24.13.1, Corepack 0.34.6, pnpm pinned `10.12.1`
>   (`package.json#packageManager`). Bare `pnpm` currently resolves to 10.12.1.
> - **Cross-references:** `docs/HERMES_PARITY_MATRIX.md` (capability-level parity),
>   `docs/CURRENT_STATE.md` (last first-hand snapshot), `docs/USER_JOURNEYS.md`
>   (flow-level dead ends).

## Scoring rubric

| Score | Meaning |
|---|---|
| 0 | Absent. |
| 1 | Type/contract/stub only; no behavior. |
| 2 | Behavior exists but partial, fragile, or not reachable from a real UI. |
| 3 | Works through a real interface with tests, but named gaps remain. |
| 4 | Complete and reachable end-to-end with automated proof; minor polish left. |
| 5 | Verified end-to-end user behavior, hardened against failure, documented. |

## Proof legend

`U`=unit · `I`=integration · `E`=e2e/smoke · `M`=manually read code this session ·
`D`=relied on existing repo tests/docs (not independently re-run this session) ·
`W`=Windows-verified.

---

## Scoreboard

| # | Category | Score | Proof | Headline gap |
|---|---|:---:|:---:|---|
| 1 | Installation & updates | 3 | D,W | Health-failure rollback path untested; apply-update automation partial |
| 2 | First-run onboarding | 3 | D | Onboarding exists CLI+web; not verified continuous to first task |
| 3 | Provider setup | 3 | D,M | OAuth (Claude/Codex) + key flows; wizard discoverability thin |
| 4 | Workspace / project setup | 3 | D,M | Create/select works; no guided "open a folder" first-run bridge |
| 5 | Interactive chat | 3 | D,M | SSE streaming CLI+web; reconnect/dedup mid-stream unproven |
| 6 | Planning | 3 | M,D | Plan steps + plan-only mode; flat, no nested child plans |
| 7 | Autonomous execution | 3 | M,D | Loop/budget guards real; verification-gating shallow |
| 8 | Tool calling | 3 | M,D | 10 tools + approvals; tool timeline UI thin |
| 9 | Coding workflow | 3 | M,D | read/search/git/diff/undo/patch; no baseline-regression auto-block |
| 10 | Terminal / process execution | 3 | M,D,W | Synchronous exec only; Windows process-tree kill verified; no background PTY |
| 11 | Browser / computer interaction | 3 | D | Playwright strong; desktop control absent |
| 12 | Subagents | 3 | M,U | Spawn+tree work with restart consistency and cancel propagation; parent synthesis still thin |
| 13 | Task trees | 3 | M,U | parent_task_id + `/tree`; no parent/child terminal-state reconciliation |
| 14 | Approvals & trust controls | 3 | M,D | Hard-block policy + YOLO guards; pending-approval-after-restart fragile |
| 15 | Cancellation | 3 | M,U,W | `/cancel` propagates descendants and has explicit route outcomes; cancel-across-restart UX remains |
| 16 | Retry / resume | 3 | M,U | Retry solid; agent continuation resume is state-aware and regression-tested |
| 17 | Crash recovery | 3 | M,U | Startup re-dispatches queued work; cancel-across-restart UX remains |
| 18 | Sessions & conversation history | 3 | M,D | Persisted conversations; resume picker UX thin |
| 19 | Memory | 4 | D | Scopes, pin, provenance, FTS, edit/delete; identity overlay partial |
| 20 | Skills | 4 | D | Registry/creator/curator/lifecycle strong; progressive disclosure partial |
| 21 | Plugin extensibility | 2 | M,D | Manifest registry only; no sandboxed hooks, no lifecycle API/CLI |
| 22 | Scheduling | 4 | D | Cron engine + ticker + API + CLI; notifications best-effort |
| 23 | Notifications | 3 | D | `/api/notify` + webhook/telegram; no native Slack/SMTP |
| 24 | Diagnostics | 3 | M,D | doctor + diagnostics API; no single support-bundle export |
| 25 | Logging & observability | 3 | M,D | Hash-chain audit + events + SSE; redaction breadth unproven |
| 26 | CLI UX | 3 | D | Rich terminal app; full-frame/palette gaps |
| 27 | TUI UX | 3 | D | Same surface; resize reflow + double-Ctrl-C unproven |
| 28 | Web UX | 3 | M,D | MissionControl/onboarding/providers/skills/health; dead-UI audit pending |
| 29 | Accessibility | 1 | M | No evidence of a11y work (focus order, ARIA, contrast, keyboard) |
| 30 | Security | 3 | M,D | Command policy, injection guard, audit, local-guard; broad review pending |
| 31 | Release engineering | 3 | D,W | release.yml + package/checksum scripts; full rehearsal checklist missing |
| 32 | Documentation | 3 | M | Extensive but partly stale/duplicated; user-facing diagnosis docs thin |

**Aggregate:** mostly 2–4. No category is a verified 5. The lowest cluster —
**crash recovery (17), cancellation (15), retry/resume (16), subagents (12),
terminal/process (10)** — is exactly the "leave it running without babysitting"
trust surface, and is the correct first program focus.

---

## Category detail

Format per category: **Exists / Works / Incomplete / Mock-or-test-only /
UI-reachable / Undocumented / Unsafe / Proof / Next milestone.**

### 1. Installation & updates — 3
- **Exists:** `installer/install.ps1` (atomic, data-preserving, rollback-capable swap), `installer/lib`, `morrow doctor`, `service/update.ts` (`checkForUpdate`, SemVer pre-release precedence), bundled Node runtime in `dist/`.
- **Works:** Fresh install, upgrade-preserving-data, corrupt-package rollback, idempotent crash-window recovery — all Windows-verified per `CURRENT_STATE.md` + `scripts/install-activation.test.mjs` (9/9).
- **Incomplete:** Apply-update automation (git pull + reinstall) is partial; uninstall preserves-data path lightly covered.
- **Mock/test-only:** —
- **UI-reachable:** `morrow update` / `morrow doctor` CLI; installer is a script.
- **Undocumented:** Update *apply* semantics for the packaged build.
- **Unsafe:** Health-failure rollback path has **no automated test** (needs a deliberately-unhealthy artifact).
- **Proof:** D, W.
- **Next:** Automated health-failure-rollback test; documented update-apply flow (Phase 10).

### 2. First-run onboarding — 3
- **Exists:** `apps/cli/src/commands/onboard.ts`, `apps/web/src/components/OnboardingWizard.tsx`, settings persistence (`user.onboarded`/`onboardingStep`).
- **Works:** Onboarding command + wizard, covered by `onboard.test.ts`.
- **Incomplete:** No verified continuous path onboarding → provider → workspace → first task in one sitting.
- **UI-reachable:** Yes (CLI + web).
- **Unsafe:** —
- **Proof:** D.
- **Next:** Journey A automation (Phase 2).

### 3. Provider setup — 3
- **Exists:** `provider/{anthropic,openai,gemini,openai-compatible,codex,mock}.ts`, OAuth/PKCE for Claude+Codex (`oauth.ts`/`oauth-flow.ts`), health checks (`connectivity.ts`, `/providers/:id/test`), secrets store.
- **Works:** Multi-provider runtime, fallback flagging, connectivity test.
- **Incomplete:** Setup *wizard* discoverability; rate-guard MISSING.
- **Unsafe:** Secrets handling needs the Phase 8 review (credential redaction in diagnostics).
- **Proof:** D, M.
- **Next:** Provider failure journey (Journey E) + rate guard.

### 4. Workspace / project setup — 3
- **Exists:** `repositories/projects.ts`, `workspace/validator.ts` (path containment), CLI `projects`.
- **Works:** Create/select project, workspace validation/canonicalization.
- **Incomplete:** No first-run "open this folder" bridge; project vs workspace language inconsistent (see `docs/PRODUCT_LANGUAGE.md` TODO).
- **Proof:** D, M.
- **Next:** Terminology unification + onboarding bridge.

### 5. Interactive chat — 3
- **Exists:** `agent_chat` tasks, SSE event stream, CLI terminal transcript, web MissionControl.
- **Works:** Streaming assistant messages, tool cards.
- **Incomplete:** Mid-stream reconnect/dedup after a drop is unproven (matrix row PARTIAL).
- **Proof:** D, M.
- **Next:** SSE reconnect dedup test.

### 6–9. Planning / Autonomous execution / Tool calling / Coding workflow — 3
- **Exists:** `execution/agent.ts` loop (plan → state machine → tools → verify), `adaptive-budget.ts`, `loop-detector.ts`, tool catalog (10), approvals, `tools/{git,diff-applier,command-executor}.ts`, `/diff` + `/undo`.
- **Works:** End-to-end agent repair e2e (`agent-repair-e2e.test.ts`), git tools, diff/undo with integration tests.
- **Incomplete:** `compareBaseline` regression detector exists but is **not wired into the write path**; verification gating is shallow (a task can complete without hard re-verify); plan is flat (no nested subagent plan).
- **Unsafe:** A confidently-wrong "completed" is possible if verification is skipped (Phase 4 false-completion risk).
- **Proof:** M, D.
- **Next:** Wire baseline-regression auto-block; verification-required gate.

### 10. Terminal / process execution — 2
- **Exists:** `tools/command-executor.ts` over `command-policy.ts`, `backends/local.ts`.
- **Works:** Bounded synchronous exec (exit code, abort, timeout) — `backends.test.ts`.
- **Incomplete:** **No background/PTY process registry** (matrix MISSING); env allow-list missing.
- **Works:** Windows command cancellation now has an acceptance fixture proving
  parent/child/grandchild termination through structured `taskkill /F /T /PID`,
  stdout/stderr closure, no hang, and unrelated-process survival.
- **Proof:** M, D, W.
- **Next:** Background process registry / PTY semantics.

### 11. Browser / computer interaction — 3
- **Exists:** `browser/playwright.ts` (real Chromium/CDP, semantic refs, click/fill/key, dialogs, screenshots, persistence, cleanup), `browser/injection-guard.ts`.
- **Works:** Browser E2E + injection tests (`browser-injection.test.ts`). Strong.
- **Incomplete:** Desktop control (UIA/AX) MISSING; cloud-session import/export missing.
- **Proof:** D.
- **Next:** Out of first-program scope; keep as-is.

### 12. Subagents — 2
- **Exists:** `POST /api/tasks/:id/subagents`, `tasks.parent_task_id`, `GET /api/tasks/:id/tree`, named agents (`repositories/agents.ts`).
- **Works:** Spawn child task, build descendant tree (`subagents.test.ts`, 6).
- **Incomplete:** No concurrency limit; parent synthesis of child results remains thin.
- **Unsafe:** Child failures and parent synthesis still need a visible Mission Control path.
- **Proof:** M, U.
- **Next:** Real delegated mission flow with visible tree, bounded context, and parent synthesis.

### 13. Task trees — 3
- **Exists/Works:** parent_task_id + `/tree` endpoint, tested.
- **Incomplete:** No reconciliation guaranteeing parent terminal state is consistent with children after restart.
- **Proof:** M, U.
- **Next:** Reconciliation slice.

### 14. Approvals & trust controls — 3
- **Exists:** `repositories/approvals.ts`, `command-policy.ts` categorical hard-blocks (shells, privilege-escalation, destructive git, force-push, exfil tools, workspace escape) enforced **before** approval so YOLO can't bypass; audit hash-chain.
- **Works:** `command-policy.test.ts` (8), `agent-yolo.test.ts` deny cases.
- **Incomplete:** Pending-approval-after-restart resumes via a raw-SQL `interrupted→queued` hack (`server.ts:888`), separate from the `/resume` path; brittle.
- **Proof:** M, D.
- **Next:** Unify approval-resume with reconciliation.

### 15. Cancellation — 2
- **Exists:** `runner.cancel()` (`/api/tasks/:id/cancel`), `/panic` stop-all.
- **Works:** Cancels queued/running, sets cancelled agent state (`runner.test.ts`).
- **Incomplete/Unsafe:** Cancel-across-restart remains an interface-level gap; CLI/web wording still needs to expose accepted vs already-cancelled vs already-terminal outcomes.
- **Proof:** M, U, W.
- **Next:** Cancellation-lifecycle slice (Phase 3B).

### 16. Retry / resume — 2
- **Exists:** `retryTask` (clean re-queue), `/retry`, `resumeInterruptedTask`, `/resume`, `task-continuations.ts`.
- **Works:** Retry of failed/interrupted (`retry.test.ts`); deterministic `inspect_workspace` resume via retry path (tested).
- **Works:** `agent_chat` resume is state-aware: fresh tasks do
  `queued→running`, interrupted continuations resume correctly, and already
  running continuations do not emit a duplicate running transition.
- **Proof:** M, U.
- **Next:** Surface resume vs retry clearly in Mission Control and CLI flows.

### 17. Crash recovery — 2 ← **first slice target**
- **Exists:** `recovery.ts#recoverRunningTasks` (called in `index.ts` at startup), interrupts `running` tasks + interrupted-streaming messages.
- **Works:** `running→interrupted` once, idempotent, leaves other states intact (`recovery.test.ts`, 2).
- **Incomplete/Unsafe:** **`queued` tasks are orphaned** — nothing re-dispatches them after restart; the runner only runs a task via an explicit API call, and `index.ts` never re-queues. A task created and queued before a crash **never executes**. Subagent children (created `queued`) inherit this. No parent/child reconciliation.
- **Proof:** M, U (read `index.ts`, `runner.ts`, `server.ts` dispatch sites; confirmed executor requires `queued` then transitions `running`, so re-dispatch is side-effect-safe).
- **Next:** Deterministic startup reconciliation that re-dispatches orphaned `queued` work idempotently with no duplicate execution (**this slice**).

### 18. Sessions & conversation history — 3
- **Exists/Works:** `repositories/conversations.ts`, persisted messages, FTS search.
- **Incomplete:** Session/resume picker UX is thin; continuation across restart relies on recovery (17).
- **Proof:** M, D.

### 19. Memory — 4
- **Exists/Works:** scopes (project/conversation/user), tiers, pin, provenance (`originTaskId`), FTS, PATCH/DELETE — all tested (`memory.test.ts`, `search.test.ts`).
- **Incomplete:** Editable identity/personality overlay PARTIAL; export not surfaced.
- **Proof:** D. **Next:** Phase 6 continuity verification + export.

### 20. Skills — 4
- **Exists/Works:** Manifests+permissions+checksum, creator (interview→generate→sandbox-verify→install), curator (backup/rollback/archive/restore/dedupe/pin), slash commands, usage tracking — extensively tested.
- **Incomplete:** Progressive disclosure (lazy reference loading); OneDrive/AV interference on Windows unproven.
- **Proof:** D. **Next:** Phase 7 Windows-filesystem hardening.

### 21. Plugin extensibility — 2
- **Exists:** `plugins/registry.ts` (validated manifest registry, disabled-by-default, persisted enable/disable, no code loading at discovery).
- **Incomplete/Unsafe:** No sandboxed runtime hooks, no permission approvals, no signed bundles, no API/CLI lifecycle, no remote sources.
- **Proof:** M, D. **Next:** Defer; extend only behind a proven use case (Phase 7).

### 22. Scheduling — 4
- **Exists/Works:** `schedule/cron.ts` (pure UTC), `ticker.ts` (isolated runs), API + CLI, notifications on fire — tested (`cron.test.ts`, `schedules.test.ts`).
- **Incomplete:** Missed-window catch-up policy is "next tick only."
- **Proof:** D.

### 23. Notifications — 3
- **Exists/Works:** `/api/notify` fan-out, webhook (Slack/Discord incoming) + telegram (token-redacted) adapters.
- **Incomplete:** Native Slack/Discord apps + SMTP email missing.
- **Proof:** D.

### 24. Diagnostics — 3
- **Exists/Works:** `morrow doctor` (node/pnpm/home/migrations/providers), `workspace/diagnostics.ts` (tsc+eslint normalize), `/api/projects/:id/diagnostics`, `diagnostics-api.test.ts`.
- **Incomplete:** No single redacted support-bundle export; no task-lifecycle/tool timeline view.
- **Proof:** M, D. **Next:** Phase 9 support bundle.

### 25. Logging & observability — 3
- **Exists/Works:** Append-only hash-chained audit (`audit/log.ts`, tamper-evident), task events, SSE stream.
- **Incomplete/Unsafe:** Redaction breadth (headers/tokens/env across all log surfaces) not proven; `console.log` debug lines remain (e.g. `inspect-workspace.ts:26`).
- **Proof:** M, D. **Next:** Redaction audit + remove stray debug logging.

### 26–28. CLI / TUI / Web UX — 3
- **Exists/Works:** Real terminal app (`apps/cli/src/terminal/*`: events→reduce→state→view→renderer), slash autocomplete, history, streaming tool cards, `/output`/`/diff`/`/undo`, no-color fallback; web `MissionControl`, `OnboardingWizard`, `ProviderManager`, `SkillsControlCenter`, `SystemHealth`.
- **Incomplete:** Full-frame alt-screen + Ctrl+K palette MISSING; resize reflow + double-Ctrl-C abort unproven; live nested task tree MISSING; web dead-UI/disconnected-state audit pending.
- **Proof:** M, D. **Next:** Phase 5 observability views; web button-by-button audit.

### 29. Accessibility — 1
- **Exists:** No evidence of focus management, ARIA, contrast, or keyboard-only paths in `apps/web`.
- **Proof:** M (absence). **Next:** a11y baseline pass (later phase).

### 30. Security — 3
- **Exists/Works:** `command-policy.ts`, `browser/injection-guard.ts`, `security/local-guard.ts`, hash-chain audit, env-filtered MCP spawn.
- **Incomplete:** Broad Phase 8 review not done (path traversal, symlink/junction, archive extraction, localhost API exposure/CORS, untrusted-repo instructions, release artifact integrity).
- **Proof:** M, D. **Next:** Phase 8 evidence-driven review.

### 31. Release engineering — 3
- **Exists/Works:** `.github/workflows/release.yml`, `scripts/package-release.mjs` + tests, checksum generation, version drift guard (ADR-0005), Windows artifact built+install-tested.
- **Incomplete:** No single objectively-verifiable `RELEASE_CHECKLIST.md`; upgrade/rollback/uninstall rehearsal not codified.
- **Proof:** D, W. **Next:** Phase 10 `RELEASE_CHECKLIST.md`.

### 32. Documentation — 3
- **Exists:** Extensive `docs/` (architecture, parity, providers, privacy, ADRs).
- **Incomplete/Unsafe:** Some docs stale/duplicated (`MORROW_STATUS.md`/`CONTINUATION.md` report wrong test counts per `CURRENT_STATE.md`); no `PRODUCT_LANGUAGE.md`; user-facing "diagnose a failure" guide thin.
- **Proof:** M. **Next:** Terminology doc + prune stale status docs.

---

## Program priority (derived)

Ordered by user value × operational risk, matching the assignment's execution
priority:

1. **Crash recovery (17)** — re-dispatch orphaned `queued` work; parent/child
   consistency; idempotent, no duplicate execution. ← **slice 1, in progress.**
2. **Cancellation & process lifecycle (15, 10)** — cancel-across-restart
   acceptance and interface wording for lifecycle outcomes.
3. **Retry/resume correctness (16)** — interface-level resume/retry distinction.
4. **Toolchain reproducibility (Phase 3C)** — Corepack-pin enforcement.
5. **Autonomous coding loop (6–9)** — verification gating, baseline auto-block.
6. **Observability (24, 25)** — task/tool timeline, support bundle, redaction.

Each slice must move a real user journey in `docs/USER_JOURNEYS.md`, ship with a
regression test + one acceptance test, and update `docs/HERMES_PARITY_MATRIX.md`.
