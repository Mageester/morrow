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

- [ ] **B4. Skill usage tracking + skill→slash commands.** Per-skill invocation
      counters persisted; expose installed skills as slash commands.
- [ ] **B5. Skill Creator (interview → generate → sandbox test → approve →
      install).** New `services/orchestrator/src/skills/creator.ts` + CLI flow.
- [ ] **B6. Skill Curator (dedupe, improve, stale/archive, pin, backup,
      rollback).**
- [ ] **B7. Cron scheduler + isolated scheduled runs + notifications.**
- [ ] **B8. Idempotency keys + explicit retry endpoint.**
- [ ] **B9. Execution backend interface + Docker sandbox backend.** (SSH after.)
- [ ] **B10. Provider rate-limit guard + live fallback-on-error.**

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
- [ ] **B22. Append-only tamper-evident audit store + scoped YOLO allow-lists +
      workspace-escape/force-push/secret-exfil guards with tests.**

## Cross-cutting acceptance suites to keep green

- `pnpm check`, `pnpm test`, `pnpm build`
- `pnpm run test:e2e`
- orchestrator smoke: `smoke:sqlite`, `smoke:vertical-slice`,
  `smoke:agent-alpha`, `smoke:providers`
