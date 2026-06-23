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
- [ ] **B9. Execution backend interface + Docker sandbox backend.** (SSH after.)
- [~] **B10. Live provider fallback-on-error.** DONE: `openStreamWithFallback`
      retries the next configured candidate on a retryable start error (never on
      fatal request errors, never mid-stream), emits `provider.fallback`, wired
      into the agent. 10 tests. REMAINING: explicit rate-limit guard/backoff.

## Later

- [ ] **B11. MCP client (stdio first, then HTTP) + tool filtering + trust.**
- [ ] **B12. Plugin manager (manifests, hooks, enable/disable/update/remove).**
- [ ] **B13. LSP diagnostics client + baseline-before-write verification.**
- [ ] **B14. Git worktrees + subagent delegation + parallel agents.**
- [ ] **B15. Browser control (Playwright/CDP) + prompt-injection guard.**
- [ ] **B16. Desktop control layer (UIA / AX / AT-SPI).**
- [ ] **B17. Messaging adapters (Telegram/Discord/Slack/email) behind one
      contract.**
- [ ] **B18. Doctor command + updater + rollback + uninstall.**
- [ ] **B19. Windows + Ubuntu one-command installers.**
- [ ] **B20. Hermes import/migration tooling (`packages/hermes-compat`).**
- [ ] **B21. TUI: live task tree, Ctrl+K palette, persisted history, resize
      reflow test, mid-stream reconnect dedup test.**
- [~] **B22. Security hard-blocks.** DONE: workspace-escape/force-push/network-
      exfil guards enforced categorically before approval, with unit +
      end-to-end (YOLO-bypass) tests. REMAINING: append-only tamper-evident
      audit store + scoped YOLO allow-lists per side-effect.

## Cross-cutting acceptance suites to keep green

- `pnpm check`, `pnpm test`, `pnpm build`
- `pnpm run test:e2e`
- orchestrator smoke: `smoke:sqlite`, `smoke:vertical-slice`,
  `smoke:agent-alpha`, `smoke:providers`
