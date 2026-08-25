# Hermes → Morrow Parity Matrix

> Living document. Every row is verified against **evidence in the Morrow tree**,
> not aspiration. A row is `VERIFIED` only when there is real backend behavior
> **and** an automated test (unit / integration / e2e) proving it.

## Legend

| Status | Meaning |
|---|---|
| `VERIFIED` | Real behavior + automated test asserting it. |
| `PARTIAL` | Usable behavior exists but a named sub-capability or test is missing. |
| `SCAFFOLD` | Types/contracts/stubs exist, no end-to-end behavior. |
| `MISSING` | Not started. |

## Reference systems

- **Hermes** (`C:\Users\aidan\OneDrive\Documents\hermes-agent`, read-only): Python
  agent. Core surface: `cli.py` (710 KB), `run_agent.py` (252 KB),
  `hermes_state.py` (223 KB), `agent/*` (~120 modules), `ui-tui/` (Node TUI),
  `web/`, `apps/desktop`, `cron/`, `gateway/`, `providers/`, `plugins/`,
  `acp_adapter/`, `optional-mcps/`, `optional-skills/`.
- **Morrow** (this repo): TypeScript pnpm/turbo monorepo. `packages/contracts`
  (zod protocol), `services/orchestrator` (Fastify runtime + agent engine),
  `apps/cli` (terminal TUI + client), `apps/web`, `apps/desktop`,
  `skills/` (built-in skills), `packages/{ui,config,hermes-compat}`.

## Baseline (captured 2026-06-22, refreshed 2026-08-19)

- 2026-06-22: `pnpm test` → 105 tests / 23 files green; ~45 HTTP routes;
  10 agent tools; 6 signed built-in skills.
- 2026-08-19: `apps/cli` → **688 passed / 3 failed** across 72 files. The three
  reproduce with all local changes stashed (`acceptance-durable-autonomy` ×2,
  `service-lifecycle` ×1) and are this machine's OneDrive path casing, not
  behaviour. `services/orchestrator` → 2256 passed / 6 failed, of which
  `flagship-web` ×2 is a Windows `EPERM` flake in an `afterEach` cleanup that
  varies run to run. **33 agent tools** in the catalog.

---

## 1. Terminal / TUI

> **Re-verified 2026-08-19 against the post-rebuild tree.** Every row in this
> section previously cited `terminal/commands.ts`, `completion.ts`,
> `input-state.ts`, `runtime.ts`, `app-view.ts`, `session.ts` and `paint.ts` as
> evidence. All seven were deleted in the v0.1.1 CLI shell rebuild (PR #79), so
> every `VERIFIED` here was resting on files that no longer exist. Rows below
> name files that do.
>
> Comparison set: Hermes `ui-tui/src` (local read-only checkout) and **pi**
> `@earendil-works/pi-coding-agent` v0.84.2. pi is now installed and on PATH —
> `docs/harness-efficiency-report-2026-08-11.md` records it as unavailable, and
> that is out of date.

| Capability | Reference evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| One command registry | Hermes splits `cli.py` and `ui-tui/` | VERIFIED | `terminal/commands/registry.ts`; handlers return a `Report` and never paint, so the Ink shell and `commands/line-surface.ts` cannot diverge. `test/terminal-command-registry.test.ts` | — |
| Slash-command autocomplete | pi `tui.input.tab` | VERIFIED | `ink/palette.tsx`, `ink/editor.ts`; `test/terminal-shell.test.tsx` | — |
| Command history | pi `tui.editor.historyPrevious` | VERIFIED | `terminal/history.ts` + `ink/editor.ts` ring; `test/terminal-history.test.ts` | — |
| Live activity indicator | pi spinner + elapsed; Hermes `thinking.tsx` | VERIFIED | `ink/activity-line.tsx` — spinner, present-tense action, elapsed, reported tokens, `esc to interrupt`; `test/terminal-shell.test.tsx` | — |
| Streaming tool rows | Hermes `streamingAssistant.tsx` | VERIFIED | `ink/work-summary.tsx` collapses repeats, never folds a failure; `ink/tool-verbs.ts` carries both tenses | — |
| Failure is visible | pi renders errors inline | VERIFIED | `ink/outcome.tsx` covers failed / stalled / budget-reached / cancelled / interrupted with the runtime's reason and next commands | — |
| Model-authored plan | Hermes `todoPanel.tsx`; pi todo display | VERIFIED | `write_plan` tool + `plan.published` → `ink/plan-view.tsx`, windowed around the running step | — |
| Reasoning display | pi `app.thinking.toggle` | VERIFIED | `ink/reasoning-view.tsx`, live tail + Ctrl+R; word-wrapped | — |
| Ctrl+K palette | pi has no equivalent | VERIFIED | `ink/palette.tsx` fuzzy, prefix-boosted; `test/terminal-shell.test.tsx` | — |
| External editor | pi `app.editor.external` (`ctrl+g`) | VERIFIED | `terminal/external-editor.ts`, Ctrl+X; raw-mode handoff in `ink/shell.tsx` | — |
| Copy last answer | pi `app.message.copy` (`ctrl+x`) | VERIFIED | `/copy` + `terminal/clipboard.ts` | — |
| Search the conversation | pi `tui.altScreen.search` (`ctrl+shift+f`) | VERIFIED | `/find` reports matching turns; `ink/transcript-overlay.tsx` searches interactively with `/`, `n`/`N` to step matches | — |
| Scrollable transcript | pi fullscreen viewport; Hermes `useVirtualHistory.ts` (554 lines) + `app/scroll.ts` | PARTIAL | `ink/transcript-overlay.tsx` (Ctrl+P, `/transcript`): scroll, search, jump between matches, top/bottom | Reading happens in an overlay, not on the live screen. Deliberate: settled turns live in Ink `<Static>`, which is what makes a long session cost the same per frame as an empty one. Scrolling the live transcript means virtualizing it and giving that up. Still missing either way: mouse selection, OSC 8 links, jump-to-previous-prompt on the main surface |
| Configurable keybindings | pi ~100 namespaced actions + `~/.pi/agent/keybindings.json` + `/reload` | MISSING | `ink/keymap.ts` — 29 bindings, hardcoded, but declared once and rendered by `/shortcuts` so they cannot drift from their documentation | No user rebinding |
| Session fork / tree | pi `--fork`, `/tree`, rename, delete, filters | MISSING | `/new`, `/resume`, `/sessions`, `/continue` only | Forking a session at a chosen turn has no equivalent |
| Themes | pi `--theme`, `--use-theme`, discovery | MISSING | `ink/theme.ts`, one palette in two layers (`vars` → roles) | No theme loading |
| Image paste | pi `app.clipboard.pasteImage` | MISSING | `usePaste` handles text only | Backend must accept images first |
| Extension management | pi `install/remove/update/list`; Hermes `pluginsHub.tsx`, `skillsHub.tsx` | PARTIAL | `/skills`, `/integrate`, `/cortex` | No in-CLI install/update flow |
| Non-interactive / scripting | pi `--print`, `--mode json/rpc`, SDK, `--export` | MISSING | Interactive shell, plus `commands/line-surface.ts` as a plain-line fallback | No `--print` or JSON mode, so no CI or pipe use |
| No-color / ASCII fallback | Hermes TUI | VERIFIED | `terminal/capabilities.ts`, `glyphs(unicode)` in `ink/theme.ts`; `test/terminal-capabilities.test.ts` | — |
| Clean Ctrl+C | pi `app.clear` | VERIFIED | Ctrl+C stops work, twice on an idle empty line exits; `test/terminal-shell.test.tsx` | — |
| Crash recovery | pi session resume | PARTIAL | `client/sse.ts` reconnect + resume cursor | Mid-stream reconnect dedup test still missing |


## 2. YOLO / autonomy & safety

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Auto-approve within scopes | Hermes auto-approve | PARTIAL | `terminal/yolo.ts`, `command-policy.ts` | Scoped allow-lists per side-effect |
| Hard-block secrets/escalation/destructive | `tool_guardrails.py`, `file_safety.py` | VERIFIED | `command-policy.ts` denies shells/privilege-escalation/deletes, destructive git history, **force-push**, **network-exfil tools**, and **workspace-redirect escape** — enforced categorically before approval (YOLO cannot bypass). `command-policy.test.ts` (8) + `agent-yolo.test.ts` end-to-end deny cases | Append-only audit hardening (tracked in §2 audit row) |
| Persistent audit log | Hermes trajectory/audit | VERIFIED | `audit/log.ts` hash-chain (`chainEntry`/`verifyChain`) + append-only `repositories/audit-log.ts` (migration 18); tampering or dropping a row fails `verify()`. `test/audit-log.test.ts` (5). Plus the existing `/api/audit` task summary | Emit entries from more event hooks |
| `/panic` stop-all | Hermes interrupt | VERIFIED | `commands/panic.ts`, `panic.test.ts`, commit `2a06928` | — |

## 3. Durable runtime

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Persistent missions/tasks | `hermes_state.py` sqlite | VERIFIED | `repositories/tasks.ts`, `database.ts` | — |
| Task graph / child tasks | Hermes subagents | VERIFIED | `tasks.parent_task_id` (migration 16) + `tasks.listChildren`; `GET /api/tasks/:id/tree` builds the descendant tree. `test/subagents.test.ts` | — |
| Pause / resume | Hermes | VERIFIED | `/resume`, `task-continuations.ts`, commit `8880dd3` | — |
| Cancel | Hermes | VERIFIED | `/cancel`, `panic.test.ts` | — |
| Retry | `retry_utils.py` | VERIFIED | `records.retryTask` (fresh attempt: resets to queued, clears continuation + agent state + assistant message; preserves event audit), `POST /api/tasks/:id/retry` (409 unless failed/interrupted; never resurrects cancelled), CLI `MorrowApi.retryTask`. `test/retry.test.ts` | — |
| Adaptive budgets | `iteration_budget.py` | VERIFIED | `execution/adaptive-budget.ts`, commit `c2f74ca` | — |
| Loop detection | Hermes | VERIFIED | `execution/loop-detector.ts` (stable-signature sliding window) wired into `execution/agent.ts`; interrupts with reason `loop_detected` before false success. Tests: `test/loop-detector.test.ts` (11) + `test/agent-loop.test.ts` (2) | — |
| Background PTY processes | Hermes terminal backends | VERIFIED | Durable process registry: migration 20 `processes` table + `processes/supervisor.ts` (owned children, bounded per-stream log capture under `MORROW_HOME/process-logs`, incremental byte-offset retrieval, graceful→forced tree kill, timeout, restart reconciliation marks prior-run rows `lost` with pid-liveness detail — a row never claims liveness). API `POST/GET /api/projects/:id/processes`, `GET /api/processes/:id[/output]`, `POST …/terminate`; policy deny-list enforced; `process.started`/`process.exited` task events. CLI `morrow processes|ps` (list/start/show/logs `--follow`/kill) + `/ps`. `test/processes.test.ts` (10, real child processes) + CLI `api-processes.test.ts` | PTY mode requires optional `node-pty` (honest refusal when absent, never silent pipe fallback) |
| Crash/reboot recovery | Hermes resume | PARTIAL | `recovery.ts` `reconcileTasksOnStartup`: `running->interrupted`, **re-dispatches orphaned `queued` tasks** (no duplicate exec — executor's first write is `queued->running`), parent/child consistency (terminal-parent orphans cancelled). E2E restart test in `recovery.test.ts` resumes a `queued` task to `verified`. | Cancel-across-restart interface acceptance + reconnect dedup |
| Scheduled jobs (cron) | `cron/` | VERIFIED | `schedule/cron.ts` (pure UTC engine) + `repositories/schedules.ts` + `schedule/ticker.ts` (isolated runs via the task runner) + API + CLI `schedule`. `test/cron.test.ts` (7) + `test/schedules.test.ts` (8) | — |
| Idempotency | Hermes | VERIFIED | `tasks(project_id, idempotency_key)` partial unique index (migration 12), `findByIdempotencyKey`, `Idempotency-Key` header/body on inspect-workspace **and** the agent-chat message send (`POST /api/conversations/:id/messages`; replay returns the original task/messages/routing with 200 + `replayed:true`; task created before messages so a lost race can't duplicate the user message; `idempotencyKey` added to `SendMessageSchema`). `test/tasks.test.ts` + `test/idempotency-api.test.ts` (6) | — |
| Session search (FTS) | `agent/memory_manager.py` FTS5 | VERIFIED | `repositories/search.ts`, migration 10 triggers, `/api/projects/:id/search`, `test/search.test.ts` (13) + `test/search-api.test.ts` (4) + CLI `test/api-search.test.ts` (3) | — |

## 4. Execution backends

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Local | Hermes local backend | VERIFIED | `backends/local.ts` (over `command-executor.ts`/`command-policy.ts`); `test/backends.test.ts` (exec, exit code, abort, timeout) | — |
| Docker sandbox | Hermes docker backend | SCAFFOLD | `backends/remote.ts` `dockerBackend` honest stub (refuses until configured; never fakes) | Real container runtime impl |
| SSH | Hermes ssh backend | SCAFFOLD | `backends/remote.ts` `sshBackend` honest stub | Real SSH impl |
| Unified backend interface | Hermes `transports/` | VERIFIED | `backends/types.ts` `ExecutionBackend`; local + remote stubs implement it; `test/backends.test.ts` | — |
| Limits / env filter / no-new-privs / process-tree kill | Hermes | PARTIAL | timeout + denied patterns + Windows `taskkill /F /T /PID` acceptance (`command-executor.test.ts`) | env allow-list, background PTY registry |

## 5. Skills

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Manifests + permissions | `skills/`, `agent/skill_utils.py` | VERIFIED | `skills/registry.ts`, `skills.test.ts`, checksum verify | — |
| Progressive disclosure | `skill_preprocessing.py` | PARTIAL | SKILL.md body | Lazy reference loading |
| Scripts / references / templates / assets | Hermes skill bundles | PARTIAL | skill dirs | Bundle resource resolution |
| Platforms | Hermes | VERIFIED | `supportedPlatforms` in manifest | — |
| Slash commands from skills | `skill_commands.py` | VERIFIED | `skillsAsSlashCommands` (verified skills → `/skill:<id>`), wired into the interactive session command list + `onSlash` `skill:` handler that records use and runs the skill. `apps/cli/test/skills.test.ts` | — |
| Usage tracking | Hermes | VERIFIED | `skill_usage` table (migration 13), `skillUsageRepository`, `GET .../skills/usage` + `POST .../skills/:id/use`, CLI `MorrowApi.recordSkillUse`. `test/skill-usage.test.ts` + CLI `api-search.test.ts` | — |

| Automatic evidence-backed skill lifecycle | Hermes self-improve | VERIFIED | migration 35 `learned_skills`; `AutomaticSkillService`; two-distinct-mission threshold; safe-command, checksum, permission and lifecycle gates; private project scope; automatic matching/use accounting; tamper quarantine + rollback. `cortex-automatic-learning.test.ts`, `agent-cortex-learning.test.ts` | Only safe routine validation procedures auto-activate |

## 6. Skill Creator & Curator

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Interview → generate skill | `curator.py` | VERIFIED | `apps/cli/src/skills/creator.ts` (`validateSkillSpec`/`generateSkillFiles`) + `skills create` interview/flag flow; generated bundle's checksum matches SKILL.md so it passes `verifySkill`. `test/skill-creator.test.ts` (7) | — |
| Sandbox test before install | Hermes | VERIFIED | `installSkill` stages to a temp dir and runs `verifySkill` before moving into place; failure leaves nothing installed. `test/skill-creator.test.ts` | — |
| Permission review + install | Hermes | VERIFIED | `skills create` prints requested tools/fs/network/secrets and gates install behind a confirm; refuses to overwrite an existing skill (curator-only). | — |
| Install a third-party skill | Hermes | VERIFIED | `skills/install.ts`: GitHub (`owner/repo[@ref]`, URL), local folder, or `.tar.gz`; a bare `SKILL.md` folder is normalized into manifest+permissions+checksum with the invented files named in the plan. Preview stages and verifies before any consent; apply promotes those exact bytes. Strict hand-written tar reader refuses symlinks, absolute and parent paths, and bounds inflation. CLI `skills install/remove`, Skills page panel, and an approval-gated `install_skill` tool. `test/skill-install.test.ts` (25), `test/skill-install-api.test.ts` (8), `test/agent-install-skill.test.ts` (7), `apps/cli/test/skills-install-command.test.ts` (9) | — |
| Improve successful skills | Hermes self-improve | VERIFIED | `skills update <id>` backs up then overwrites + re-verifies (`curator.ts` + `creator.installSkill({overwrite})`). `test/skill-curator.test.ts` "improve (update) path" | — |
| Duplicate detection | Hermes | VERIFIED | `curator.findDuplicates` (deterministic Jaccard over SKILL.md tokens), CLI `skills dedupe`. `test/skill-curator.test.ts` | — |
| Lifecycle: stale/archive/pin/backup/rollback | `curator_backup.py` | VERIFIED | `curator.ts` `backupSkill`/`listBackups`/`rollbackSkill` (re-verified restore), `archiveSkill`/`restoreArchived` (out of discovery), pin via config; CLI `backup/backups/rollback/archive/restore/archived/pin/unpin`. `test/skill-curator.test.ts` (5) | — |

## 7. Memory & identity

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Working/project/user memory | `memory_manager.py` | VERIFIED | `repositories/memory.ts`, scopes project/conversation/user | — |
| Episodic / procedural / knowledge | Hermes tiers | VERIFIED | `MemoryScopeSchema` tiers, `listActiveForConversation` includes all project-wide tiers, `test/memory.test.ts` "new project-wide tiers" | — |
| FTS session search | Hermes FTS5 | VERIFIED | `repositories/search.ts` indexes the `memory` kind too; project-scoped; `test/search.test.ts` covers memory matching + project isolation | — |
| Provenance | Hermes | VERIFIED | `originTaskId` FK to tasks (migration 11), `test/memory.test.ts` "stores task provenance" | — |
| Explain / edit / delete | Hermes | VERIFIED | `/api/memory/:id` PATCH/DELETE | — |
| Pin | Hermes | VERIFIED | `pinned` column + pin-first ordering, `setPinned`, PATCH `{pinned}`, CLI `memory pin/unpin`, `test/memory.test.ts` + CLI `api-search.test.ts` | — |
| Automatic lifecycle capture + ranked recall | Hermes memory manager | VERIFIED | migration 35 rich lifecycle metadata; `AutomaticMemoryService`; mission-start `CortexService.ensureReady`; evidence-only capture, secret/poison rejection, scoped staleness, relevance ranking and use counters. `cortex-automatic-learning.test.ts`, `agent-cortex-learning.test.ts` | — |
| Identity file / project instructions | `system_prompt.py`, AGENTS.md | PARTIAL | prompt builder reads project | Editable identity + personality overlay |

## 8. Coding intelligence

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Project index | `coding_context.py` | VERIFIED | Parser-backed persisted symbol index: migration 24 `symbol_index_files` + `symbols`, `repositories/symbols.ts`, `workspace/symbol-index.ts` using the TypeScript compiler API for TS/JS/TSX/JSX and parsed JSON config keys. Supports rebuild, refresh, changed/deleted/renamed cleanup, ignore rules, diagnostics, cancellation, resource limits, search, definition lookup, file symbols, API, CLI `morrow symbols`, and read-only/agent `search_symbols`. Tests: `symbol-index.test.ts`, `symbol-index-api.test.ts`, `agent-alpha.test.ts`, `tools-catalog.test.ts`, CLI `api-symbols.test.ts`, `symbols-command.test.ts` | Broader semantic/vector search remains separate |
| Semantic search | Hermes | PARTIAL | `workspace/search.ts` (text) + symbol lookup through `search_symbols` | Embedding/semantic ranking beyond literal text and symbol metadata |
| LSP diagnostics | `agent/lsp/` | VERIFIED | `workspace/diagnostics.ts` normalizes tsc + eslint output into structured `Diagnostic[]`; `GET /api/projects/:id/diagnostics` (injectable runner). `test/diagnostics.test.ts` (9) + `test/diagnostics-api.test.ts` (3) | Real LSP stdio client is a later enhancement |
| Baseline-before-write verify | `file_safety.py` | VERIFIED | `workspace/diagnostics.ts` parses bounded tsc/ESLint output and `execution/agent.ts` records same-family snapshots, compares the next verification after a workspace mutation, emits `verification.completed`, and keeps regressions in the completion blocker. `test/diagnostics.test.ts` plus agent completion coverage | Broader LSP/semantic diagnostics remain separate |
| Git worktrees / parallel agents | Hermes | VERIFIED | Migration 21 `worktrees` table + `repositories/worktrees.ts` + `workspace/worktrees.ts`: creates per-agent/task branches and checked-out worktrees under Morrow control, dispatches agent execution inside the assigned worktree, preserves task/worktree linkage, and exposes worktree lifecycle through API, CLI `morrow worktrees`, `/worktrees`, and `morrow chat --worktree`. Tests: `services/orchestrator/test/worktrees.test.ts`, `apps/cli/test/api-worktrees.test.ts`, `apps/cli/test/worktrees-command.test.ts` | Source worktrees are intentionally preserved after integration until explicit cleanup lands |
| Commit / PR prep | Hermes | PARTIAL | `tools/git.ts` | PR body generation |
| Conflict handling | Hermes | VERIFIED | Migration 22 `integration_attempts` table + `repositories/integrations.ts` + `workspace/integrations.ts`: records isolated worktree integration checks, dry-runs merges in a temporary local clone, reports clean/conflicted/failed status with conflicted files, refuses dirty targets, refuses stale target HEADs, applies only previously clean attempts with `--no-ff`, and preserves the source worktree/branch. API under `/api/worktrees/:id/integrations/check`, `/api/projects/:id/integrations`, `/api/integrations/:id/apply|cancel`; CLI `morrow integrate`. Tests: `services/orchestrator/test/integrations.test.ts`, `apps/cli/test/api-integrations.test.ts`, `apps/cli/test/integrations-command.test.ts` | Conflict resolution UI is still manual; this slice detects and records conflicts safely |

## 9. Browser & desktop control

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Playwright/CDP browser | `agent/browser_provider.py`, `agent-browser` | VERIFIED | `browser/playwright.ts`: real Playwright Chromium lifecycle, CDP attach, semantic DOM refs, navigation, click/fill/key/select, responsive viewport control, dialogs, bounded evidence, timeout/cancellation, explicit pause/resume/panic and owned-process cleanup. `execution/agent.ts` exposes these controls progressively behind an exact-origin approval. `agent-browser.test.ts` drives real Chromium through the agent boundary. | Managed/cloud browser backends remain missing. |
| Sessions/screenshots/uploads | Hermes | VERIFIED | Isolated and profile-backed persistent sessions; bounded PNG screenshots; explicit download/upload roots with real-path/symlink containment; console/page-error evidence; `browser/audit.ts` writes sanitized task-scoped records into the append-only audit log. Screenshots are durable task artifacts while pixels are ephemeral model input only on verified vision routes. | Cloud-session import/export is missing. |
| Prompt-injection and material-action protection | Hermes | VERIFIED | `browser/injection-guard.ts` neutralizes instruction/role/system-prompt/exfiltration payloads; URL policy rejects unsupported schemes, credentials, metadata and private-network targets unless explicitly allowed; audit output redacts secrets. Credential/payment fields and purchase/destructive-account/release/deploy/push actions are blocked in the agent bridge. | — |
| Frontend validation loop | Hermes | VERIFIED | Frontend changes cannot complete without post-change navigation, DOM, console, interaction, exact desktop/tablet/mobile screenshots, and verified vision attachment. Failure and full-pass paths are covered in `agent-browser.test.ts`; legacy styling recovery fixtures also satisfy the gate. | Packaged browser acceptance remains a release gate. |
| Desktop control (UIA/AX/AT-SPI) | Hermes computer-use | MISSING | — | Desktop layer |

## 10. MCP & plugins

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| MCP stdio/HTTP client | `mcp_serve.py`, `optional-mcps/` | VERIFIED | `mcp/client.ts` (JSON-RPC 2.0, transport-agnostic) + `mcp/framing.ts` (newline-delimited) + `mcp/stdio-transport.ts` (env-filtered spawn). `test/mcp.test.ts` (6, in-process fake server) | HTTP transport is a thin add on the same client; orchestrator routes pending |
| OAuth/PKCE | Hermes | PARTIAL | `provider/oauth.ts` (findings only) | Real PKCE for MCP |
| Tool filtering / discovery / sampling limits | Hermes | PARTIAL | `McpClient` allow-list filtering + `tools/list` discovery (`test/mcp.test.ts`) | Sampling limits |
| Plugin manifests/hooks/lifecycle/trust | `plugins/` | PARTIAL | `plugins/registry.ts`: local validated manifest registry, disabled-by-default install, persisted enable/disable/update/remove, and no code loading during discovery. `test/plugin-registry.test.ts` (2). Existing MCP command trust remains separate. | Signed bundles, sandboxed runtime hooks, permission approvals, API/CLI lifecycle and remote sources. |

## 11. Automation & messaging

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Cron scheduler | `cron/` | VERIFIED | `schedule/cron.ts` + `schedule/ticker.ts` (`SchedulerTicker.start/tick`, injectable clock), started in `index.ts`. Tests as above | — |
| Isolated scheduled runs | Hermes | VERIFIED | ticker creates a fresh task per due schedule via the same runner + containment; `test/schedules.test.ts` "fires one isolated task per due schedule" | — |
| Notifications | Hermes | VERIFIED | `POST /api/notify` fans out to configured adapters; the scheduler ticker notifies on a fired schedule (best-effort, never fails the task). `test/messaging.test.ts` + `test/schedules.test.ts` "notifies configured adapters" | — |
| Telegram/Discord/Slack/email adapters | `gateway/` | PARTIAL | `messaging/adapter.ts`: `MessageAdapter` contract + `webhookAdapter` (covers Slack/Discord *incoming webhooks*) + `telegramAdapter` (token-redacted), `loadAdaptersFromEnv`. `test/messaging.test.ts` (8) | Native Slack/Discord apps + SMTP email |

## 12. Provider orchestration

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Multi-provider | `providers/`, `agent/*_adapter.py` | VERIFIED | `provider/{anthropic,openai,gemini,openai-compatible,mock}.ts` | — |
| Health checks | Hermes | VERIFIED | `provider/connectivity.ts`, `/providers/:id/test` | — |
| Fallback | Hermes | VERIFIED | `provider/fallback.ts` `openStreamWithFallback` (retryable-only, no mid-stream switch) wired into `execution/agent.ts`; primary failure falls back to the next configured candidate and emits `provider.fallback`. Tests: `provider-fallback.test.ts` (8) + `agent-fallback.test.ts` (2) | — |
| Rate limits | `nous_rate_guard.py`, `rate_limit_tracker.py` | VERIFIED | `provider/rate-guard.ts` (`RateGuard`: per-provider cooldown, Retry-After honored, exponential backoff 2s→5m cap, success reset; advisory not blocking) wired into `openStreamWithFallback` (rate-limited candidates deprioritized, never skipped) + `execution/agent.ts` (`provider.rate_limited` event) + `GET /api/providers/rate-limits`. Adapters parse `Retry-After` into the 429 payload. `test/rate-guard.test.ts` (13) | Persisted cross-restart cooldowns intentionally omitted (stale-state risk) |
| Local/cloud routing | Hermes | VERIFIED | `routing/presets.ts` privacy classes | — |
| Context limits | `context_engine.py` | VERIFIED | `execution/context-budget.ts` now provides a provider-neutral context manager: exact offline `js-tiktoken` counts for OpenAI-family models, conservative labeled estimates for unsupported/unknown providers, centralized model-window/output/tool/framing/safety reservations, valid message-group trimming, deterministic redacted compaction into persisted `context_summaries`, hard refusal before oversized provider calls, metadata-only context events, task aggregate `context`, Mission Control context lines, and `/context`. Tests: `context-budget.test.ts`, `agent-alpha.test.ts`, `api.test.ts`, `mission-control.test.ts`. | Exact tokenization is OpenAI-family only; Anthropic/Gemini/Ollama/OpenAI-compatible unknown models use conservative estimates. Model-assisted summaries remain optional future polish; deterministic compaction is the default. |
| Profiles | Hermes | VERIFIED | `routing/presets.ts`, `presets.test.ts` | — |

## 13. Distribution

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Windows install (no git/pnpm knowledge) | `install.ps1` | VERIFIED | `installer/install.ps1` — one-command (`iex (irm …/install.ps1)`), atomic data-preserving upgrade with rollback + crash-window recovery (ADR-0004). Tested: `scripts/install-activation.test.mjs` (9, real Windows) + `scripts/install-integration.test.mjs` (full 47 MB artifact → install → health → `morrow doctor`) + CI static safety guard (`scripts/lib/installer-safety.mjs`) | Health-failure rollback path lacks an automated test (needs deliberately unhealthy artifact) |
| Ubuntu install | `install.sh` | MISSING | — | One-command installer (source build documented in README) |
| Onboarding | `agent/onboarding.py` | VERIFIED | `commands/onboard.ts`, `onboard.test.ts`, commit `bf8ae79` | — |
| Provider setup wizard | `hermes setup` | PARTIAL | onboarding provider step | — |
| Update / rollback | `hermes update` | PARTIAL | `service/update.ts` (`compareSemver`, `checkForUpdate`, injectable `fetchLatestVersion`) + `morrow update` command. `test/doctor-update.test.ts` | Apply-update (git pull+install) automation + rollback |
| Uninstall | Hermes | VERIFIED | `installer/templates/uninstall.ps1` — removes app/bin/shortcuts/PATH entry; data preserved by default with explicit `-PurgeData`/`-KeepData` flags and a safe-default prompt. Covered by `scripts/package-command.test.mjs` + `validate-repository` checks | No automated end-to-end uninstall run on CI (needs Windows artifact) |
| Service management | Hermes | VERIFIED | `service/lifecycle.ts`, `service-lifecycle.test.ts` | — |
| Doctor | `hermes doctor` | VERIFIED | `morrow doctor` (node/pnpm/home/migrations/providers checks) with testable `service/doctor-checks.ts` `aggregateDoctor`. `test/doctor-update.test.ts` | — |
| Migration / import | `hermes claw migrate`, `hermes-compat` | PARTIAL | `@morrow/hermes-compat` (`parseHermesEnv`/`mapToMorrow`/`summarizeImport`, `test/import.test.ts` 4) + CLI `morrow import hermes <path>` (`apps/cli/src/commands/import.ts`): offline dry-run report by default, `--apply` maps provider aliases (claude→anthropic, google→gemini, …) and configures provider+model+key through the same service path as `providers configure`; secret values never printed in human or JSON output. `test/import-command.test.ts` (6) | Session/skill import |

## 14. Cross-cutting

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Subagents / delegation | Hermes spawn | VERIFIED | `POST /api/tasks/:id/subagents` spawns an isolated child task run via the normal runner; composes with persistent named agents (`repositories/agents.ts`, committed `feat(agents)`). `test/subagents.test.ts` (6) | — |
| Model routing | Hermes | VERIFIED | `routing/router.ts`, `models.ts` | — |
| Checkpoints | Hermes | VERIFIED | Named workspace checkpoints: migration 19 `checkpoints` table + `repositories/checkpoints.ts` + `workspace/checkpoints.ts` (content-addressed snapshots sharing the undo backup store; containment-gated; restore verifies all blobs up front and auto-saves an `auto/pre-restore-…` safety checkpoint so restores are reversible). API: POST/GET/restore/DELETE under `/api/projects/:id/checkpoints` (`CreateCheckpointSchema` in contracts). CLI: `/checkpoint save|list|restore|delete`. Tests: `test/checkpoints.test.ts` (8) + `apps/cli/test/api-checkpoints.test.ts` (3) | Interactive TUI mode points to line mode for now |
| Diff / undo | Hermes | VERIFIED | server diff/undo + integration test | — |
| Recovery | Hermes | PARTIAL | `recovery.ts` `reconcileTasksOnStartup` + e2e restart test; project-scoped agent continuation resume, explicit resume/retry controls, and redacted support bundle summaries are covered in `retry.test.ts`, `conversations.test.ts`, and web API/component tests | Mid-stream reconnect/dedup and parent synthesis remain |

---

## How rows graduate to VERIFIED

1. Implement real backend behavior in `services/orchestrator` (or `apps/cli`).
2. Express it through `packages/contracts` if it crosses the API boundary.
3. Add unit + integration tests; add e2e when user-visible.
4. Run `pnpm check && pnpm test && pnpm build` (and `pnpm run test:e2e` for UI).
5. Update this matrix row with the evidence path and flip status.
6. Commit a coherent slice and push.
