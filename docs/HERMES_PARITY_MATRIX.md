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

## Baseline (captured 2026-06-22)

- `pnpm test` → **105 tests / 23 files green** (`apps/cli` 105; orchestrator &
  contracts suites cached green).
- Orchestrator exposes ~45 HTTP routes (`services/orchestrator/src/server.ts`).
- 10 agent tools in catalog; 6 signed built-in skills.

---

## 1. Terminal / TUI

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Full-screen interactive TUI | `ui-tui/src`, `cli.py` curses loop | PARTIAL | `apps/cli/src/terminal/*` (events→reduce→state→view→renderer) | Alt-screen full-frame layout, live mission header |
| Multiline input | TUI editor | PARTIAL | `terminal/input-state.ts`, `prompt.ts` | Verify soft-wrap + paste; tests |
| Slash-command autocomplete | TUI | VERIFIED | `terminal/commands.ts`, `completion.ts`, `terminal-completion.test.ts` | — |
| Command history | TUI | PARTIAL | `prompt.ts` history ring | Persisted cross-session history |
| Streaming tool cards | TUI streaming | VERIFIED | `terminal/state.ts` ToolCard, `terminal-view.test.ts` | — |
| Live task tree | Hermes plan view | MISSING | plan steps render flat | Nested child-task tree |
| Bounded transcript | TUI scrollback cap | PARTIAL | `state.ts` transcript cap | Verify cap + `/output` overflow |
| `/output` viewer | TUI | VERIFIED | `commands.ts` + bounded viewer commit `60d72ce` | — |
| `/diff` | TUI diff | VERIFIED | `commands.ts`, server `/api/tasks/:id/diff`, integration test | — |
| `/undo` | TUI undo | VERIFIED | `commands.ts`, server `/api/tasks/:id/undo`, integration test | — |
| Ctrl+K palette | — | MISSING | — | Command palette |
| Resize handling | TUI | PARTIAL | `renderer.ts` width clip | SIGWINCH reflow test |
| No-color / ASCII fallback | TUI | VERIFIED | `capabilities.ts`, `view.ts` glyphs, `terminal-capabilities.test.ts` | — |
| Clean Ctrl+C | TUI | PARTIAL | `runtime.ts` signal handling | Double-Ctrl-C abort test |
| Crash recovery (no dup / false fail) | TUI reconnect | PARTIAL | `recovery.ts`, SSE resume | Mid-stream reconnect dedup test |

## 2. YOLO / autonomy & safety

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Auto-approve within scopes | Hermes auto-approve | PARTIAL | `terminal/yolo.ts`, `command-policy.ts` | Scoped allow-lists per side-effect |
| Hard-block secrets/escalation/destructive | `tool_guardrails.py`, `file_safety.py` | VERIFIED | `command-policy.ts` denies shells/privilege-escalation/deletes, destructive git history, **force-push**, **network-exfil tools**, and **workspace-redirect escape** — enforced categorically before approval (YOLO cannot bypass). `command-policy.test.ts` (8) + `agent-yolo.test.ts` end-to-end deny cases | Append-only audit hardening (tracked in §2 audit row) |
| Persistent audit log | Hermes trajectory/audit | PARTIAL | `/api/audit`, `AuditEntrySchema` | Append-only tamper-evident audit store |
| `/panic` stop-all | Hermes interrupt | VERIFIED | `commands/panic.ts`, `panic.test.ts`, commit `2a06928` | — |

## 3. Durable runtime

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Persistent missions/tasks | `hermes_state.py` sqlite | VERIFIED | `repositories/tasks.ts`, `database.ts` | — |
| Task graph / child tasks | Hermes subagents | MISSING | flat tasks | parent/child edges |
| Pause / resume | Hermes | VERIFIED | `/resume`, `task-continuations.ts`, commit `8880dd3` | — |
| Cancel | Hermes | VERIFIED | `/cancel`, `panic.test.ts` | — |
| Retry | `retry_utils.py` | PARTIAL | `adaptive-budget.ts` attempts | Explicit retry endpoint + idempotency |
| Adaptive budgets | `iteration_budget.py` | VERIFIED | `execution/adaptive-budget.ts`, commit `c2f74ca` | — |
| Loop detection | Hermes | VERIFIED | `execution/loop-detector.ts` (stable-signature sliding window) wired into `execution/agent.ts`; interrupts with reason `loop_detected` before false success. Tests: `test/loop-detector.test.ts` (11) + `test/agent-loop.test.ts` (2) | — |
| Background PTY processes | Hermes terminal backends | MISSING | synchronous exec only | Background process registry |
| Crash/reboot recovery | Hermes resume | PARTIAL | `recovery.ts` | Reboot-survival integration test |
| Scheduled jobs (cron) | `cron/` | MISSING | — | Scheduler + isolated runs |
| Idempotency | Hermes | VERIFIED | `tasks(project_id, idempotency_key)` partial unique index (migration 12), `findByIdempotencyKey`, `Idempotency-Key` header/body on task creation returns the original task. `test/tasks.test.ts` + `test/idempotency-api.test.ts` | Extend to the agent-chat creation path |
| Session search (FTS) | `agent/memory_manager.py` FTS5 | VERIFIED | `repositories/search.ts`, migration 10 triggers, `/api/projects/:id/search`, `test/search.test.ts` (13) + `test/search-api.test.ts` (4) + CLI `test/api-search.test.ts` (3) | — |

## 4. Execution backends

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Local | Hermes local backend | VERIFIED | `tools/command-executor.ts`, `command-policy.ts` | — |
| Docker sandbox | Hermes docker backend | MISSING | — | Container backend behind one interface |
| SSH | Hermes ssh backend | MISSING | — | SSH backend |
| Unified backend interface | Hermes `transports/` | MISSING | — | `ExecutionBackend` abstraction |
| Limits / env filter / no-new-privs / process-tree kill | Hermes | PARTIAL | timeout + denied patterns | env allow-list, ptree kill |

## 5. Skills

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Manifests + permissions | `skills/`, `agent/skill_utils.py` | VERIFIED | `skills/registry.ts`, `skills.test.ts`, checksum verify | — |
| Progressive disclosure | `skill_preprocessing.py` | PARTIAL | SKILL.md body | Lazy reference loading |
| Scripts / references / templates / assets | Hermes skill bundles | PARTIAL | skill dirs | Bundle resource resolution |
| Platforms | Hermes | VERIFIED | `supportedPlatforms` in manifest | — |
| Slash commands from skills | `skill_commands.py` | VERIFIED | `skillsAsSlashCommands` (verified skills → `/skill:<id>`), wired into the interactive session command list + `onSlash` `skill:` handler that records use and runs the skill. `apps/cli/test/skills.test.ts` | — |
| Usage tracking | Hermes | VERIFIED | `skill_usage` table (migration 13), `skillUsageRepository`, `GET .../skills/usage` + `POST .../skills/:id/use`, CLI `MorrowApi.recordSkillUse`. `test/skill-usage.test.ts` + CLI `api-search.test.ts` | — |

## 6. Skill Creator & Curator

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Interview → generate skill | `curator.py` | MISSING | — | Guided creator |
| Sandbox test before install | Hermes | MISSING | — | Dry-run validation |
| Permission review + install | Hermes | MISSING | — | Approval gate |
| Improve successful skills | Hermes self-improve | MISSING | — | Improvement loop |
| Duplicate detection | Hermes | MISSING | — | Similarity check |
| Lifecycle: stale/archive/pin/backup/rollback | `curator_backup.py` | MISSING | — | Lifecycle mgr |

## 7. Memory & identity

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Working/project/user memory | `memory_manager.py` | VERIFIED | `repositories/memory.ts`, scopes project/conversation/user | — |
| Episodic / procedural / knowledge | Hermes tiers | VERIFIED | `MemoryScopeSchema` tiers, `listActiveForConversation` includes all project-wide tiers, `test/memory.test.ts` "new project-wide tiers" | — |
| FTS session search | Hermes FTS5 | VERIFIED | `repositories/search.ts` indexes the `memory` kind too; project-scoped; `test/search.test.ts` covers memory matching + project isolation | — |
| Provenance | Hermes | VERIFIED | `originTaskId` FK to tasks (migration 11), `test/memory.test.ts` "stores task provenance" | — |
| Explain / edit / delete | Hermes | VERIFIED | `/api/memory/:id` PATCH/DELETE | — |
| Pin | Hermes | VERIFIED | `pinned` column + pin-first ordering, `setPinned`, PATCH `{pinned}`, CLI `memory pin/unpin`, `test/memory.test.ts` + CLI `api-search.test.ts` | — |
| Identity file / project instructions | `system_prompt.py`, AGENTS.md | PARTIAL | prompt builder reads project | Editable identity + personality overlay |

## 8. Coding intelligence

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Project index | `coding_context.py` | PARTIAL | `workspace/inspector.ts` | Persisted symbol index |
| Semantic search | Hermes | PARTIAL | `workspace/search.ts` (text) | Symbol/semantic search |
| LSP diagnostics | `agent/lsp/` | MISSING | — | LSP client + diagnostics |
| Baseline-before-write verify | `file_safety.py` | PARTIAL | `workspace/validator.ts` | Pre-write baseline capture test |
| Git worktrees / parallel agents | Hermes | MISSING | — | Worktree manager |
| Commit / PR prep | Hermes | PARTIAL | `tools/git.ts` | PR body generation |
| Conflict handling | Hermes | MISSING | — | Merge/conflict detection |

## 9. Browser & desktop control

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Playwright/CDP browser | `agent/browser_provider.py`, `agent-browser` | MISSING | — | Browser tool w/ DOM refs |
| Sessions/screenshots/uploads | Hermes | MISSING | — | — |
| Prompt-injection protection | Hermes | MISSING | — | Injection guard |
| Desktop control (UIA/AX/AT-SPI) | Hermes computer-use | MISSING | — | Desktop layer |

## 10. MCP & plugins

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| MCP stdio/HTTP client | `mcp_serve.py`, `optional-mcps/` | MISSING | — | MCP client |
| OAuth/PKCE | Hermes | PARTIAL | `provider/oauth.ts` (findings only) | Real PKCE for MCP |
| Tool filtering / discovery / sampling limits | Hermes | MISSING | — | — |
| Plugin manifests/hooks/lifecycle/trust | `plugins/` | MISSING | — | Plugin manager |

## 11. Automation & messaging

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Cron scheduler | `cron/` | MISSING | — | See §3 |
| Isolated scheduled runs | Hermes | MISSING | — | — |
| Notifications | Hermes | MISSING | — | — |
| Telegram/Discord/Slack/email adapters | `gateway/` | MISSING | — | Adapter contract + ≥1 impl |

## 12. Provider orchestration

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Multi-provider | `providers/`, `agent/*_adapter.py` | VERIFIED | `provider/{anthropic,openai,gemini,openai-compatible,mock}.ts` | — |
| Health checks | Hermes | VERIFIED | `provider/connectivity.ts`, `/providers/:id/test` | — |
| Fallback | Hermes | VERIFIED | `provider/fallback.ts` `openStreamWithFallback` (retryable-only, no mid-stream switch) wired into `execution/agent.ts`; primary failure falls back to the next configured candidate and emits `provider.fallback`. Tests: `provider-fallback.test.ts` (8) + `agent-fallback.test.ts` (2) | — |
| Rate limits | `nous_rate_guard.py`, `rate_limit_tracker.py` | MISSING | — | Rate guard |
| Local/cloud routing | Hermes | VERIFIED | `routing/presets.ts` privacy classes | — |
| Context limits | `context_engine.py` | PARTIAL | preset `contextBudgetBytes` | Token-accurate trimming |
| Profiles | Hermes | VERIFIED | `routing/presets.ts`, `presets.test.ts` | — |

## 13. Distribution

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Windows install (no git/pnpm knowledge) | `install.ps1` | MISSING | — | One-command installer |
| Ubuntu install | `install.sh` | MISSING | — | One-command installer |
| Onboarding | `agent/onboarding.py` | VERIFIED | `commands/onboard.ts`, `onboard.test.ts`, commit `bf8ae79` | — |
| Provider setup wizard | `hermes setup` | PARTIAL | onboarding provider step | — |
| Update / rollback | `hermes update` | MISSING | — | Updater |
| Uninstall | Hermes | MISSING | — | — |
| Service management | Hermes | VERIFIED | `service/lifecycle.ts`, `service-lifecycle.test.ts` | — |
| Doctor | `hermes doctor` | MISSING | — | Diagnostics command |
| Migration / import | `hermes claw migrate`, `hermes-compat` | SCAFFOLD | `packages/hermes-compat` (README only) | Import tooling |

## 14. Cross-cutting

| Capability | Hermes evidence | Morrow status | Morrow evidence | Gap |
|---|---|---|---|---|
| Subagents / delegation | Hermes spawn | MISSING | — | Subagent runner |
| Model routing | Hermes | VERIFIED | `routing/router.ts`, `models.ts` | — |
| Checkpoints | Hermes | PARTIAL | `change-sets.ts` | Named checkpoints + restore |
| Diff / undo | Hermes | VERIFIED | server diff/undo + integration test | — |
| Recovery | Hermes | PARTIAL | `recovery.ts` | Reboot survival test |

---

## How rows graduate to VERIFIED

1. Implement real backend behavior in `services/orchestrator` (or `apps/cli`).
2. Express it through `packages/contracts` if it crosses the API boundary.
3. Add unit + integration tests; add e2e when user-visible.
4. Run `pnpm check && pnpm test && pnpm build` (and `pnpm run test:e2e` for UI).
5. Update this matrix row with the evidence path and flip status.
6. Commit a coherent slice and push.
