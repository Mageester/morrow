# Morrow Backlog (impact-ranked)

Ordering optimizes for: high user value, architectural cleanliness, full
testability, and unblocking later work. Each item is a coherent, committable
slice. `[x]` = VERIFIED (backend + tests + matrix updated). `[~]` = in progress.

## Now

- [x] **B1. Session & memory search (FTS).** SQLite FTS5 over conversations,
      messages, and tasks. Contract + repository + `/api/search` route + CLI
      `/search` command + tests. Unblocks §3 and §7 of the matrix.
- [x] **B2. Memory provenance + pin + tiers.** Add `pinned`, richer `source`
      (origin taskId), and `episodic`/`procedural`/`knowledge` scopes; pin
      ordering in retrieval; explain endpoint. Extends `repositories/memory.ts`.
- [x] **B3. Loop detection.** Stable-signature sliding-window detector
      (`loop-detector.ts`) wired into the agent loop; interrupts with reason
      `loop_detected` before false success. 13 tests.

## Next

- [x] **B4. Skill usage tracking + skill→slash commands.** Per-project usage
      counters (table + repo + API + CLI client); verified skills surface as
      `/skill:<id>` commands wired into the session and invoke + record use.
- [x] **B5. Skill Creator (interview → generate → sandbox test → approve →
      install).** `apps/cli/src/skills/creator.ts` (validate/generate/install) +
      `skills create` interview/flag flow; generated bundles pass `verifySkill`.
- [x] **B6. Skill Curator (dedupe, improve, stale/archive, pin, backup,
      rollback).** `apps/cli/src/skills/curator.ts` + `skills` subcommands
      (dedupe/update/backup/backups/rollback/archive/restore/archived/pin/unpin).
- [x] **B7. Cron scheduler + isolated scheduled runs.** Pure UTC cron engine,
      schedules repo, `SchedulerTicker`, API + CLI `schedule`. (Notifications:
      events emitted; external delivery folded into B17 messaging.)
- [x] **B8. Idempotency keys + explicit retry.** DONE: idempotent task creation
      (partial unique index + `Idempotency-Key` replay) AND `POST /tasks/:id/retry`
      (fresh attempt; 409 unless failed/interrupted; never resurrects cancelled).
      REMAINING (minor): extend idempotency to the agent-chat creation path.
- [~] **B9. Execution backend interface + local backend.** DONE: `ExecutionBackend`
      interface + `localBackend` (over command-executor) + honest Docker/SSH
      stubs that refuse until configured. REMAINING: real Docker + SSH impls.
- [~] **B10. Live provider fallback-on-error.** DONE: `openStreamWithFallback`
      retries the next configured candidate on a retryable start error (never on
      fatal request errors, never mid-stream), emits `provider.fallback`, wired
      into the agent. 10 tests. REMAINING: explicit rate-limit guard/backoff.

## Later

- [~] **B11. MCP client.** DONE: JSON-RPC stdio client (`mcp/client.ts`),
      framing, env-filtered spawn transport, tool-filtering allow-list, and
      fingerprint trust store. REMAINING: HTTP transport, registry + routes,
      OAuth/PKCE, sampling limits.
- [ ] **B12. Plugin manager (manifests, hooks, enable/disable/update/remove).**
- [~] **B13. Diagnostics + baseline.** DONE: provider-agnostic diagnostics
      (`workspace/diagnostics.ts` tsc/eslint parsers + `compareBaseline`) +
      `GET /diagnostics` route. REMAINING: wire `compareBaseline` into the agent
      write path; real LSP stdio client.
- [~] **B14. Subagent delegation + task graph.** DONE: `parent_task_id` +
      `listChildren`, `POST /tasks/:id/subagents`, `GET /tasks/:id/tree`;
      composes with persistent named agents (`feat(agents)`). REMAINING: git
      worktrees for parallel isolated agent workspaces.
- [ ] **B15. Browser control (Playwright/CDP) + prompt-injection guard.**
- [ ] **B16. Desktop control layer (UIA / AX / AT-SPI).**
- [~] **B17. Messaging adapters.** DONE: `MessageAdapter` contract + webhook
      (covers Slack/Discord incoming webhooks) + telegram (token-redacted),
      `POST /api/notify`, scheduler notifications. REMAINING: native Slack/Discord
      apps + SMTP email.
- [~] **B18. Doctor + updater.** DONE: `morrow doctor` (testable
      `aggregateDoctor`), `morrow update` (semver check via injectable source).
      REMAINING: apply-update automation, rollback, uninstall.
- [ ] **B19. Windows + Ubuntu one-command installers.**
- [~] **B20. Hermes import.** DONE: `@morrow/hermes-compat` real package —
      config parse + honest mapping (no invented keys, no leaked secrets).
      REMAINING: CLI `morrow import` wiring + session/skill import.
- [~] **B21. TUI polish.** DONE: persisted cross-session command history
      (`terminal/history.ts`, wired via `onHistory`). REMAINING: live task tree,
      Ctrl+K palette completeness, resize-reflow test, reconnect-dedup test.
- [~] **B22b. Tamper-evident audit store.** DONE: hash-chained append-only
      `audit_log` (`audit/log.ts` + `repositories/audit-log.ts`, migration 18);
      `verify()` detects tampering/reorder/drop. REMAINING: emit from more hooks
      + scoped YOLO allow-lists per side-effect.
- [~] **B22. Security hard-blocks.** DONE: workspace-escape/force-push/network-
      exfil guards enforced categorically before approval, with unit +
      end-to-end (YOLO-bypass) tests. REMAINING: append-only tamper-evident
      audit store + scoped YOLO allow-lists per side-effect.

## Cross-cutting acceptance suites to keep green

- `pnpm check`, `pnpm test`, `pnpm build`
- `pnpm run test:e2e`
- orchestrator smoke: `smoke:sqlite`, `smoke:vertical-slice`,
  `smoke:agent-alpha`, `smoke:providers`
